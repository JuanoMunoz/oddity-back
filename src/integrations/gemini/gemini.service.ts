import { Inject, Injectable } from '@nestjs/common';
import { GEMINI_AI } from './gemini-config';
import {
  type GoogleGenAI,
  type GenerateContentConfig,
  type Content,
  createPartFromUri,
  Part,
} from '@google/genai';

import type { History } from './dto/chat-gemini-dto';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as XLSX from 'xlsx';
import { Readable, PassThrough } from 'stream';
import ExcelJS from 'exceljs';

// ═══════════════════════════════════════════════
// Pipeline constants
// ═══════════════════════════════════════════════
const CHUNK_MAX_OUTPUT_TOKENS = 65000;   // token budget per LLM call
const TOKENS_PER_CHAR = 0.25;            // ~4 chars per token (conservative)
const SAFE_TOKEN_MARGIN = 0.65;          // use 65 % of the budget for input rows
const FALLBACK_CHUNK_SIZE = 80;          // rows when dynamic sizing cannot be computed
const CHUNK_INTER_DELAY_MS = 1500;       // mandatory inter-chunk pause (rate limiting)
const MAX_RETRIES = 5;                   // retries per chunk (fail-hard after)
const BASE_DELAY_MS = 12000;             // base exponential back-off
const MAX_RAW_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB guard on LLM response size
const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
const CHECKPOINT_PREFIX = 'gemini-ckpt-'; // temp dir prefix for checkpoint files

// ═══════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════

export interface ChunkJob {
  chunkIdx: number;
  headers: string[];
  rows: string[][];
  startRowNum: number;      // 1-based, data rows only (header = row 0)
  inputChecksum: number;    // sum of all cell char lengths in this chunk
}

export interface PipelineMetrics {
  totalRows: number;
  totalChunks: number;
  failedChunks: number;
  retriedChunks: number;
  elapsedMs: number;
  rowsPerSec: number;
}

// ═══════════════════════════════════════════════
// Pure helpers (module-level, no state)
// ═══════════════════════════════════════════════

/** Sum of all character lengths in a row set — cheap integrity stamp */
function rowChecksum(rows: string[][]): number {
  let n = 0;
  for (const row of rows) for (const cell of row) n += cell.length;
  return n;
}

/**
 * Dynamic chunk size based on avg chars per row and available token budget.
 * Formula: floor((maxTokens * margin) / (avgCharsPerRow * tokensPerChar))
 */
function computeChunkSize(sampleRows: string[][], maxTokens: number): number {
  if (sampleRows.length === 0) return FALLBACK_CHUNK_SIZE;
  const totalChars = sampleRows.reduce((acc, r) => acc + r.join(';').length, 0);
  const avgChars = totalChars / sampleRows.length;
  const tokensPerRow = avgChars * TOKENS_PER_CHAR;
  if (tokensPerRow <= 0) return FALLBACK_CHUNK_SIZE;
  const size = Math.floor((maxTokens * SAFE_TOKEN_MARGIN) / tokensPerRow);
  return Math.max(10, Math.min(size, 500)); // clamp [10, 500]
}

/** Build a temp-file path for the checkpoint of a given job. */
function checkpointPath(jobId: string): string {
  return path.join(os.tmpdir(), `${CHECKPOINT_PREFIX}${jobId}.json`);
}

/** Read checkpoint: returns last successfully written chunkIdx or 0. */
async function readCheckpoint(jobId: string): Promise<number> {
  try {
    const raw = await fs.readFile(checkpointPath(jobId), 'utf8');
    const data = JSON.parse(raw);
    return typeof data.lastChunk === 'number' ? data.lastChunk : 0;
  } catch {
    return 0;
  }
}

/** Write checkpoint with the last successfully completed chunkIdx. */
async function writeCheckpoint(jobId: string, lastChunk: number): Promise<void> {
  await fs.writeFile(
    checkpointPath(jobId),
    JSON.stringify({ lastChunk, updatedAt: new Date().toISOString() }),
    'utf8',
  );
}

/** Delete checkpoint file after successful pipeline completion. */
async function clearCheckpoint(jobId: string): Promise<void> {
  await fs.unlink(checkpointPath(jobId)).catch(() => { });
}

@Injectable()
export class GeminiService {
  private readonly model: string = 'gemini-2.5-flash';

  /** Default config — chat / general use */
  private readonly config: GenerateContentConfig = {
    thinkingConfig: { thinkingBudget: 0 },
    tools: [],
    temperature: 0,
    topP: 1,
    maxOutputTokens: 8192,
    safetySettings: [],
  };

  /** Chunk config — deterministic, full token budget */
  private readonly chunkConfig: GenerateContentConfig = {
    thinkingConfig: { thinkingBudget: 0 },
    tools: [],
    temperature: 0,
    topP: 1,
    maxOutputTokens: CHUNK_MAX_OUTPUT_TOKENS,
    safetySettings: [],
  };

  constructor(
    @Inject(GEMINI_AI)
    private readonly ai: GoogleGenAI,
  ) { }

  // ───────────────────────────────────────────────────────────
  // PUBLIC: ask (single prompt)
  // ───────────────────────────────────────────────────────────
  async ask(prompt: string, systemInstruction?: string) {
    return this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { ...this.config, systemInstruction: systemInstruction || '' },
    });
  }

  // ───────────────────────────────────────────────────────────
  // PUBLIC: chat (with history)
  // ───────────────────────────────────────────────────────────
  async chat(history: History[], prompt: string, systemInstruction?: string) {
    const historyMapped: Content[] = history.map((h) => ({
      role: h.role === 'ai' || h.role === 'model' ? 'model' : 'user',
      parts: [{ text: h.text }],
    }));
    const contents: Content[] = [
      ...historyMapped,
      { role: 'user', parts: [{ text: prompt }] },
    ];
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents,
      config: { ...this.config, systemInstruction: systemInstruction || '' },
    });
    return { text: response.text };
  }

  // ───────────────────────────────────────────────────────────
  // PRIVATE: isExcelFile
  // ───────────────────────────────────────────────────────────
  isExcelFile(file: Express.Multer.File): boolean {
    return (
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    );
  }

  // ───────────────────────────────────────────────────────────
  // LAYER 1 — ExcelStreamReader
  //
  // Single-pass ExcelJS streaming reader.
  // Yields ChunkJob objects without loading the full file.
  // Chunk size is computed dynamically from the first sample batch.
  // ───────────────────────────────────────────────────────────
  private async *streamExcelChunks(
    buffer: Buffer,
    resumeFromChunk = 0,
  ): AsyncGenerator<ChunkJob> {
    const tmpPath = path.join(os.tmpdir(), `excel-in-${Date.now()}.xlsx`);
    await fs.writeFile(tmpPath, buffer);

    try {
      const workbook = new ExcelJS.stream.xlsx.WorkbookReader(tmpPath, {});

      let headers: string[] = [];
      let chunkBuffer: string[][] = [];
      let chunkIdx = 0;
      let dataRowNum = 0;
      let chunkStartRow = 2; // Data usually starts at row 2
      let chunkSize = FALLBACK_CHUNK_SIZE;
      let chunkSizeComputed = false;
      let headersFound = false;
      const sampleAccumulator: string[][] = [];

      for await (const worksheet of workbook) {
        console.log(`[Pipeline] Accessing worksheet...`);



        for await (const row of worksheet) {
          if (!row || !row.values || !Array.isArray(row.values)) continue;

          const rawValues = (row.values as any[]).slice(1);

          // ── Header detection logic ──
          if (!headersFound) {
            const possibleHeaders = rawValues.map((v: any) =>
              v === null || v === undefined ? '' : String(v),
            );

            // Heuristic: first row with non-empty content is the header
            if (possibleHeaders.some(h => h.trim().length > 0)) {
              headers = possibleHeaders;
              headersFound = true;
              chunkStartRow = row.number + 1;
              console.log(`[Pipeline] Headers detected on row ${row.number}: [${headers.slice(0, 3).join(', ')}...]`);
              continue;
            }

            continue;
          }

          // ── Data row ──
          dataRowNum++;
          const normalized: string[] = Array.from(
            { length: headers.length },
            (_, i) => {
              const v = rawValues[i];
              return v === null || v === undefined ? '' : String(v);
            },
          );
          chunkBuffer.push(normalized);


          // ── Dynamic chunk size ──
          if (!chunkSizeComputed) {
            sampleAccumulator.push(normalized);
            if (sampleAccumulator.length >= 20) {
              chunkSize = computeChunkSize(sampleAccumulator, CHUNK_MAX_OUTPUT_TOKENS);
              chunkSizeComputed = true;
              console.log(`[Pipeline] Dynamic chunk size calculated: ${chunkSize} rows`);
            }
          }

          if (chunkBuffer.length >= chunkSize) {
            chunkIdx++;

            if (chunkIdx <= resumeFromChunk) {
              console.log(`[Pipeline] Skipping chunk ${chunkIdx} (resume)`);
              chunkStartRow = row.number + 1;
              chunkBuffer = [];
              continue;
            }

            yield {
              chunkIdx,
              headers,
              rows: chunkBuffer,
              startRowNum: chunkStartRow,
              inputChecksum: rowChecksum(chunkBuffer),
            };
            chunkStartRow = row.number + 1;
            chunkBuffer = [];
          }
        }
      }

      // ── Final partial chunk ──
      if (chunkBuffer.length > 0) {
        chunkIdx++;
        if (chunkIdx > resumeFromChunk) {
          yield {
            chunkIdx,
            headers,
            rows: chunkBuffer,
            startRowNum: chunkStartRow,
            inputChecksum: rowChecksum(chunkBuffer),
          };
        }
      }
    } finally {
      await fs.unlink(tmpPath).catch(() => { });
    }
  }


  // ───────────────────────────────────────────────────────────
  // LAYER 2 — Safe CSV serializer
  // ───────────────────────────────────────────────────────────
  private rowsToCSV(rows: string[][]): string {
    return rows.map(r => r.join(';')).join('\n');
  }

  // ───────────────────────────────────────────────────────────
  // LAYER 3 — LLM Output Parser (hardened)
  //
  // Contract:
  //   • Strip code fences
  //   • Normalise ; vs , delimiter
  //   • Trim each line
  //   • NEVER discard a line: pad short rows, truncate long rows
  // ───────────────────────────────────────────────────────────
  private parseLlmRows(raw: string, expectedCols: number): string[][] {
    let cleaned = raw
      .replace(/```(?:csv|text)?\n?([\s\S]*?)\n?```/g, '$1')
      .trim();

    // Prefer ; but fall back to , if no ; found
    if (!cleaned.includes(';') && cleaned.includes(',')) {
      cleaned = cleaned.replace(/,/g, ';');
    }

    return cleaned
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(line => {
        const cols = line.split(';');
        if (cols.length === expectedCols) return cols;
        if (cols.length < expectedCols) {
          while (cols.length < expectedCols) cols.push('');
          return cols;
        }
        return cols.slice(0, expectedCols); // truncate surplus columns
      });
  }

  // ───────────────────────────────────────────────────────────
  // LAYER 4 — LLMProcessor
  //
  // Guarantees (fail-hard on ALL of these):
  //   1. parsedRows.length === inputRows.length  (strict equality)
  //   2. raw response ≤ MAX_RAW_RESPONSE_BYTES   (corruption guard)
  //   3. Each row has exactly expectedCols        (enforced by parser)
  //   4. Exponential back-off on retryable HTTP errors
  //   5. Model fallback on attempt ≥ 2
  // ───────────────────────────────────────────────────────────
  async processChunk(
    job: ChunkJob,
    prompt: string,
    systemInstruction: string,
    metrics?: { retriedChunks: number; failedChunks: number },
  ): Promise<string[][]> {
    const { headers, rows: inputRows, chunkIdx, startRowNum, inputChecksum } = job;
    const expectedCols = headers.length;
    const inputCount = inputRows.length;
    const endRowNum = startRowNum + inputCount - 1;
    const label = `chunk ${chunkIdx} (rows ${startRowNum}–${endRowNum})`;
    const t0 = Date.now();

    console.log(`[Pipeline] START ${label} | rows=${inputCount} inputChecksum=${inputChecksum}`);

    const dataCsv = this.rowsToCSV(inputRows);
    const chunkPrompt =
      `${prompt}\n\n---\nDATA CHUNK [${label}]:\n${dataCsv}\n---\n` +
      `STRICT CONTRACT:\n` +
      `- Respond ONLY with semicolon-separated CSV rows.\n` +
      `- Do NOT include any header row.\n` +
      `- Each row MUST have exactly ${expectedCols} columns.\n` +
      `- No markdown, no explanations, no preamble, no trailing text.\n` +
      `- You MUST return EXACTLY ${inputCount} rows — one per input row, in the same order.`;

    const contents: Content[] = [{ role: 'user', parts: [{ text: chunkPrompt }] }];
    let modelToUse = this.model;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.ai.models.generateContent({
          model: modelToUse,
          contents,
          config: { ...this.chunkConfig, systemInstruction },
        });

        // Robust text extraction for @google/genai SDK
        let raw = '';
        if (typeof (result as any).text === 'string') {
          raw = (result as any).text;
        } else if ((result as any).candidates?.[0]?.content?.parts?.[0]?.text) {
          raw = (result as any).candidates[0].content.parts[0].text;
        } else if (typeof (result as any).text === 'function') {
          raw = (result as any).text();
        }

        raw = (raw || '').trim();
        console.log(`[Pipeline] LLM Response length: ${raw.length} chars | First 50 chars: ${raw.substring(0, 50).replace(/\n/g, ' ')}...`);


        // ── Guard: oversized response → corruption ──
        if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_RESPONSE_BYTES) {
          const msg = `[Pipeline] ${label}: response >2 MB on attempt ${attempt}.`;
          console.warn(msg);
          if (attempt < MAX_RETRIES) {
            if (metrics) metrics.retriedChunks++;
            await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
            continue;
          }
          if (metrics) metrics.failedChunks++;
          throw new Error(`${msg} FAIL-HARD.`);
        }

        const parsedRows = this.parseLlmRows(raw, expectedCols);

        // ── Strict row-count equality — no tolerance ──
        if (parsedRows.length !== inputCount) {
          const msg =
            `[Pipeline] ${label}: expected ${inputCount} rows, ` +
            `got ${parsedRows.length} on attempt ${attempt}.`;
          console.warn(msg);
          if (attempt < MAX_RETRIES) {
            if (metrics) metrics.retriedChunks++;
            await new Promise(r => setTimeout(r, BASE_DELAY_MS * attempt));
            continue;
          }
          if (metrics) metrics.failedChunks++;
          throw new Error(`${msg} FAIL-HARD after ${MAX_RETRIES} retries.`);
        }

        const outputChecksum = rowChecksum(parsedRows);
        const elapsedMs = Date.now() - t0;
        console.log(
          `[Pipeline] OK ${label} | attempt=${attempt} elapsed=${elapsedMs}ms ` +
          `inputChecksum=${inputChecksum} outputChecksum=${outputChecksum}`,
        );
        return parsedRows;

      } catch (err: any) {
        const status: number = err?.status ?? err?.response?.status ?? 0;
        const isRetryable = status === 503 || status === 429 || status === 500;

        if (isRetryable && attempt < MAX_RETRIES) {
          let delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          if (status === 429 && err?.details) {
            const retryInfo = err.details.find(
              (d: any) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo',
            );
            if (retryInfo?.retryDelay) {
              const secs = parseFloat(retryInfo.retryDelay.replace('s', ''));
              if (!isNaN(secs)) delay = Math.max(delay, secs * 1000 + 1000);
            }
          }
          if (attempt >= 2 && modelToUse === this.model) {
            modelToUse = FALLBACK_MODEL;
            console.warn(`[Pipeline] ${label}: switching to fallback model.`);
          }
          if (metrics) metrics.retriedChunks++;
          console.warn(`[Pipeline] ${label}: HTTP ${status}, retry in ${delay}ms (attempt ${attempt}).`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          if (metrics) metrics.failedChunks++;
          throw err;
        }
      }
    }

    if (metrics) metrics.failedChunks++;
    throw new Error(`[Pipeline] ${label}: exhausted all ${MAX_RETRIES} retries. FAIL-HARD.`);
  }

  // ───────────────────────────────────────────────────────────
  // LAYER 5 — PipelineOrchestrator
  //
  // Streams the output directly into a PassThrough that the
  // caller (controller) pipes straight to the HTTP response.
  //
  // Architecture:
  //   ExcelJS stream reader (1 pass, O(chunk) memory)
  //     → ChunkJob async generator
  //       → LLMProcessor (validate + retry)
  //         → Backpressure-aware PassThrough write
  //           → HTTP response stream
  //
  // Checkpoint: after each successful chunk, writes chunkIdx to
  // a temp JSON file so a restart can resume mid-file.
  //
  // Returns the PassThrough stream to the caller immediately.
  // The caller must pipe it; when it ends, processing is done.
  // ───────────────────────────────────────────────────────────
  streamExcelPipeline(
    file: Express.Multer.File,
    prompt: string,
    systemInstruction: string,
    jobId: string,
    onProgress?: (msg: string) => void,
  ): PassThrough {
    const output = new PassThrough();

    // Kick off async work without blocking the caller
    (async () => {
      const metrics = {
        totalRows: 0,
        totalChunks: 0,
        failedChunks: 0,
        retriedChunks: 0,
        startMs: Date.now(),
      };

      // ── Persistent Storage Logic ──
      const resultsDir = path.join(process.cwd(), 'results');
      if (!fsSync.existsSync(resultsDir)) {
        fsSync.mkdirSync(resultsDir, { recursive: true });
      }
      const filePath = path.join(resultsDir, `${jobId}.xlsx`);
      const fileStream = fsSync.createWriteStream(filePath);

      // We use a broadcaster PassThrough to fork the Excel stream: 
      // 1. To the file on disk (permanent storage)
      // 2. To the 'output' PassThrough (immediate HTTP download)
      const broadcaster = new PassThrough();
      broadcaster.pipe(fileStream);
      broadcaster.pipe(output);

      // ── Create Excel Streaming Writer ──
      const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: broadcaster,
        useStyles: false,
        useSharedStrings: false,
      });


      try {
        const resumeFrom = await readCheckpoint(jobId);
        if (resumeFrom > 0) {
          console.log(`[Pipeline] Resuming jobId=${jobId} from chunk ${resumeFrom}`);
        }

        let worksheet: ExcelJS.Worksheet | null = null;

        for await (const job of this.streamExcelChunks(file.buffer, resumeFrom)) {
          metrics.totalChunks++;

          // Lazy initialise worksheet with headers
          if (!worksheet) {
            worksheet = writer.addWorksheet('Result');
            worksheet.addRow(job.headers);
            console.log(`[Pipeline] Worksheet initialized with ${job.headers.length} headers`);
          }

          if (onProgress) {
            onProgress(
              `chunk ${job.chunkIdx} | rows ${job.startRowNum}–${job.startRowNum + job.rows.length - 1}`,
            );
          }

          const outputRows = await this.processChunk(job, prompt, systemInstruction, metrics);
          metrics.totalRows += outputRows.length;

          // Write rows to Excel stream
          for (const row of outputRows) {
            worksheet.addRow(row);
          }

          // Commit current chunk to prevent extreme memory build-up in the writer internal buffer
          // (though workbook writer usually handles this, periodic worksheet.commit isn't available
          // in the stream writer, it commits on writer.commit())
          // Actually, we just keep adding; WorkbookWriter streams parts.

          // Persist checkpoint
          await writeCheckpoint(jobId, job.chunkIdx);

          // Rate-limit pause
          await new Promise(r => setTimeout(r, CHUNK_INTER_DELAY_MS));
        }

        if (worksheet) {
          console.log(`[Pipeline] Finalizing Excel workbook; total rows: ${metrics.totalRows}`);
        } else {
          console.warn(`[Pipeline] No data processed. Creating empty sheet.`);
          writer.addWorksheet('Empty').addRow(['No se encontraron datos para procesar']);
        }

        await writer.commit();

        // Wait for file stream to finish to ensure Zip structure is intact on disk
        await new Promise<void>((resolve) => {
          if (fileStream.writableFinished) resolve();
          else fileStream.once('finish', resolve);
        });

        await clearCheckpoint(jobId);

        const elapsedMs = Date.now() - metrics.startMs;
        console.log(
          `[Pipeline] DONE jobId=${jobId} | ` +
          `rows=${metrics.totalRows} chunks=${metrics.totalChunks} ` +
          `elapsed=${elapsedMs}ms | Saved: ${filePath}`,
        );


        // The writer.commit() closes the internal stream, which closes 'output'.
      } catch (err: any) {
        console.error(`[Pipeline] FATAL jobId=${jobId}:`, err?.message ?? err);
        // Clean up partial corrupted file
        fileStream.destroy();
        await fs.unlink(filePath).catch(() => { });
        output.destroy(err instanceof Error ? err : new Error(String(err)));
      }

    })();

    return output;
  }


  // ───────────────────────────────────────────────────────────
  // PUBLIC: analyzeFilesChunked
  //
  // Backwards-compatible entry point for the SSE controller path.
  // For the new streaming download path use streamExcelPipeline().
  //
  // Returns { text: <absolute path to output CSV> }.
  // Caller MUST pipe/stream the file and delete it after.
  // ───────────────────────────────────────────────────────────
  async analyzeFilesChunked(
    files: Express.Multer.File[],
    prompt: string,
    systemInstruction?: string,
    onProgress?: (message: string) => void,
  ): Promise<{ text: string }> {
    const sysInst = systemInstruction || '';
    const excelFiles = files.filter(f => this.isExcelFile(f));
    const otherFiles = files.filter(f => !this.isExcelFile(f));

    if (excelFiles.length === 0) {
      const fallback = await this.analyzeFiles(files, prompt, sysInst);
      return { text: fallback.text ?? '' };
    }

    const outPath = path.join(os.tmpdir(), `gemini-out-${Date.now()}.csv`);
    const writeStream = fsSync.createWriteStream(outPath, { encoding: 'utf8' });

    const writeLine = (line: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const ok = writeStream.write(line + '\n');
        if (ok) return resolve();
        writeStream.once('drain', resolve);
        writeStream.once('error', reject);
      });

    const closeStream = (): Promise<void> =>
      new Promise((resolve, reject) => {
        writeStream.end((err?: Error | null) => {
          if (err) reject(err); else resolve();
        });
      });

    try {
      const metrics = { totalRows: 0, totalChunks: 0, failedChunks: 0, retriedChunks: 0 };
      let headersWritten = false;

      for (const excelFile of excelFiles) {
        const jobId = `sse-${Date.now()}`;
        for await (const job of this.streamExcelChunks(excelFile.buffer, 0)) {
          if (!headersWritten) {
            await writeLine(job.headers.join(';'));
            headersWritten = true;
          }

          if (onProgress) {
            const endRow = job.startRowNum + job.rows.length - 1;
            onProgress(`chunk ${job.chunkIdx} (rows ${job.startRowNum}–${endRow})`);
          }

          const outputRows = await this.processChunk(job, prompt, sysInst, metrics);
          metrics.totalRows += outputRows.length;

          for (const row of outputRows) {
            await writeLine(row.join(';'));
          }

          await writeCheckpoint(jobId, job.chunkIdx);
          await new Promise(r => setTimeout(r, CHUNK_INTER_DELAY_MS));
        }
        await clearCheckpoint(`sse-${Date.now()}`);
      }

      if (otherFiles.length > 0) {
        const otherResult = await this.analyzeFiles(otherFiles, prompt, sysInst);
        if (otherResult.text) await writeLine(otherResult.text);
      }

      await closeStream();
      console.log(`[Gemini] analyzeFilesChunked → output: ${outPath}`);
      return { text: outPath };
    } catch (err) {
      writeStream.destroy();
      await fs.unlink(outPath).catch(() => { });
      throw err;
    }
  }

  // ───────────────────────────────────────────────────────────
  // PUBLIC: analyzeFiles (Gemini Files API upload)
  //
  // ⚠ WARNING: NOT suitable for files with >50 k rows.
  // This method loads the entire workbook into memory via
  // XLSX.read(). Use streamExcelPipeline() for large files.
  // ───────────────────────────────────────────────────────────
  async analyzeFiles(
    files: Express.Multer.File[],
    prompt: string,
    systemInstruction?: string,
  ) {
    const uploadedFiles: any[] = [];
    const tempFilePaths: string[] = [];

    try {
      for (const file of files) {
        let finalBuffer = file.buffer;
        let finalMimeType = file.mimetype;
        let finalFileName = file.originalname;

        if (this.isExcelFile(file)) {
          try {
            const workbook = XLSX.read(file.buffer, { type: 'buffer' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const csvContent = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false, FS: ';' });
            finalBuffer = Buffer.from(csvContent);
            finalMimeType = 'text/csv';
            finalFileName = file.originalname.replace(/\.xlsx?$/, '.csv');
          } catch (excelErr) {
            console.error('[Gemini] Excel→CSV conversion failed, uploading raw:', excelErr);
          }
        }

        const tempFilePath = path.join(os.tmpdir(), `${Date.now()}-${finalFileName}`);
        await fs.writeFile(tempFilePath, finalBuffer);
        tempFilePaths.push(tempFilePath);

        const fileUploaded = await this.ai.files.upload({
          file: tempFilePath,
          config: { mimeType: finalMimeType, displayName: finalFileName },
        });

        if (!fileUploaded.name || !fileUploaded.uri || !fileUploaded.mimeType) {
          throw new Error(`[Gemini] File upload failed for ${file.originalname}: missing properties.`);
        }
        uploadedFiles.push(fileUploaded);
      }

      for (const fileUploaded of uploadedFiles) {
        let getFile = await this.ai.files.get({ name: fileUploaded.name });
        while (getFile.state === 'PROCESSING') {
          console.log(`[Gemini] Waiting on ${fileUploaded.displayName}: ${getFile.state}`);
          await new Promise(r => setTimeout(r, 3000));
          getFile = await this.ai.files.get({ name: fileUploaded.name });
        }
        if (getFile.state === 'FAILED') {
          throw new Error(`[Gemini] File processing failed: ${fileUploaded.displayName}`);
        }
      }

      const parts: Part[] = [{ text: prompt }];
      for (const fileUploaded of uploadedFiles) {
        if (fileUploaded.uri && fileUploaded.mimeType) {
          parts.push(createPartFromUri(fileUploaded.uri, fileUploaded.mimeType));
        }
      }

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: { ...this.config, systemInstruction: systemInstruction || '' },
      });

      return { text: response.text };
    } finally {
      for (const tmpPath of tempFilePaths) {
        await fs.unlink(tmpPath).catch(() => { });
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  // PUBLIC: validateAccountingCSV
  // ───────────────────────────────────────────────────────────
  validateAccountingCSV(text: string): { isValid: boolean; error?: string } {
    const cleanText = text.replace(/```(?:csv|text)?\n?([\s\S]*?)\n?```/g, '$1').trim();
    const lines = cleanText.split('\n').filter(l => l.trim() !== '');
    if (lines.length <= 1) return { isValid: true };

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(';');
      if (cols.length !== 27) {
        return {
          isValid: false,
          error: `Fila ${i + 1} tiene ${cols.length} columnas, se esperaban 27. Contenido: ${lines[i].substring(0, 50)}...`,
        };
      }
    }

    const invoices: Record<string, { debits: number; credits: number }> = {};
    const headers = lines[0].toLowerCase().split(';');
    let debitIdx = headers.findIndex(h => h.includes('debito') || h.includes('débito'));
    let creditIdx = headers.findIndex(h => h.includes('credito') || h.includes('crédito'));
    let idIdx = headers.findIndex(h => h.includes('documento') || h.includes('factura') || h.includes('comprobante'));

    if (debitIdx === -1) debitIdx = 15;
    if (creditIdx === -1) creditIdx = 16;
    if (idIdx === -1) idIdx = 2;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(';');
      const id = cols[idIdx]?.trim() || 'unnamed';
      const debit = parseFloat(cols[debitIdx]?.replace(',', '.') || '0') || 0;
      const credit = parseFloat(cols[creditIdx]?.replace(',', '.') || '0') || 0;
      if (!invoices[id]) invoices[id] = { debits: 0, credits: 0 };
      invoices[id].debits += debit;
      invoices[id].credits += credit;
    }

    for (const [id, totals] of Object.entries(invoices)) {
      if (Math.abs(totals.debits - totals.credits) > 1) {
        return {
          isValid: false,
          error: `La factura/documento ${id} no está cuadrada. Débitos: ${totals.debits.toFixed(2)}, Créditos: ${totals.credits.toFixed(2)}`,
        };
      }
    }

    return { isValid: true };
  }
}
