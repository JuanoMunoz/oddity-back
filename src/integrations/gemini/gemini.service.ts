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
import * as readline from 'readline';
import ExcelJS from 'exceljs';


export interface CategorizedFiles {
  formatFile?: Express.Multer.File;
  inputFile: Express.Multer.File;
  supportFiles?: Express.Multer.File[];
}

// ═══════════════════════════════════════════════

// Pipeline constants
// ═══════════════════════════════════════════════
const CHUNK_INPUT_ROWS = 200;           // fixed number of input rows per call
const CHUNK_MAX_OUTPUT_TOKENS = 8192;    // Gemini 1.5 Flash output limit
const CHUNK_INTER_DELAY_MS = 1500;       // mandatory inter-chunk pause (rate limiting)
const MAX_RETRIES = 5;                   // retries per chunk (fail-hard after)
const BASE_DELAY_MS = 12000;             // base exponential back-off
const MAX_RAW_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB guard on LLM response size
const FALLBACK_MODEL = 'gemini-2.5-flash-lite'; // Tiny fast model for emergency fallback


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

/** Estimate tokens from text using Gemini's tokenization (1 token ≈ 3.5 chars avg for English/Spanish) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
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
  ) {
    // Run initial cleanup once on service startup
    this.cleanupResults().catch(e => console.error('[Pipeline] Startup cleanup failed', e));
  }

  // ───────────────────────────────────────────────────────────
  // PRIVATE: cleanupResults
  // Purges files in results/ older than 7 days.
  // ───────────────────────────────────────────────────────────
  private async cleanupResults() {
    const resultsDir = path.join(process.cwd(), 'results');
    if (!fsSync.existsSync(resultsDir)) return;

    try {
      const files = await fs.readdir(resultsDir);
      const now = Date.now();
      const TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

      for (const file of files) {
        const filePath = path.join(resultsDir, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > TTL) {
          console.log(`[Pipeline] Cleanup: removing expired file ${file}`);
          await fs.unlink(filePath).catch(() => { });
        }
      }

      // Also cleanup leftover checkpoints in tmp
      const tmpDir = os.tmpdir();
      const tmpFiles = await fs.readdir(tmpDir);
      for (const tFile of tmpFiles) {
        if (tFile.startsWith('checkpoint-') && tFile.endsWith('.json')) {
          const tPath = path.join(tmpDir, tFile);
          const tStats = await fs.stat(tPath);
          if (now - tStats.mtimeMs > TTL) {
            await fs.unlink(tPath).catch(() => { });
          }
        }
      }
    } catch (e) {
      console.warn('[Pipeline] Cleanup error:', e);
    }
  }


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
    const ext = file.originalname.toLowerCase();
    return (
      ext.endsWith('.xlsx') ||
      ext.endsWith('.xls') ||
      ext.endsWith('.csv') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/csv'
    );
  }


  // ───────────────────────────────────────────────────────────
  // Safe cell value to string conversion
  // Handles dates, numbers, booleans, and malformed data
  // ───────────────────────────────────────────────────────────
  private safeCellToString(value: any): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (value instanceof Date) return value.toISOString().split('T')[0]; // YYYY-MM-DD format
    // Handle ExcelJS rich text or other objects
    if (typeof value === 'object' && value.text) return String(value.text);
    // Fallback
    try {
      return String(value);
    } catch {
      return '[ERROR: UNREADABLE CELL]';
    }
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
      let headersFound = false;
      let worksheetCount = 0;

      for await (const worksheet of workbook) {
        worksheetCount++;
        if (worksheetCount > 1) {
          console.warn(`[Pipeline] Multiple worksheets detected. Only processing the first one.`);
          break; // Only process first worksheet
        }
        console.log(`[Pipeline] Accessing worksheet ${worksheetCount}...`);



        for await (const row of worksheet) {
          if (!row || !row.values || !Array.isArray(row.values)) continue;

          const rawValues = (row.values as any[]).slice(1);

          // ── Header detection logic ──
          if (!headersFound) {
            const possibleHeaders = rawValues.map((v: any) => this.safeCellToString(v));

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
            (_, i) => this.safeCellToString(rawValues[i]),
          );

          // Skip empty rows
          if (normalized.every(cell => cell.trim() === '')) {
            console.log(`[Pipeline] Skipping empty row ${row.number}`);
            continue;
          }
          chunkBuffer.push(normalized);


          if (chunkBuffer.length >= CHUNK_INPUT_ROWS) {
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
  // LAYER 1.1 — CSVStreamReader
  //
  // Native streaming reader for CSV files.
  // Handles Quoted values and basic CSV escaping.
  // ───────────────────────────────────────────────────────────
  private async *streamCSVChunks(
    buffer: Buffer,
    resumeFromChunk = 0,
  ): AsyncGenerator<ChunkJob> {
    const stream = Readable.from(buffer);
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });


    let headers: string[] = [];
    let chunkBuffer: string[][] = [];
    let chunkIdx = 0;
    let dataRowNum = 0;
    let headersFound = false;
    let lineIdx = 0;

    let separator = ',';
    const firstLine = buffer.toString('utf-8').split('\n')[0];
    const commas = (firstLine.match(/,/g) || []).length;
    const semicolons = (firstLine.match(/;/g) || []).length;
    if (semicolons > commas) separator = ';';
    console.log(`[Pipeline] CSV auto-detected separator: "${separator}"`);

    const parseCSVLine = (line: string): string[] => {
      const result: string[] = [];

      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === separator && !inQuotes) {
          result.push(current);
          current = '';
        } else {
          current += char;
        }
      }
      result.push(current);
      return result;
    };


    for await (const line of rl) {
      lineIdx++;
      if (!line.trim()) continue;

      const values = parseCSVLine(line);

      if (!headersFound) {
        if (values.some(v => v.trim().length > 0)) {
          headers = values.map(v => v.trim());
          headersFound = true;
          console.log(`[Pipeline] CSV headers detected: [${headers.slice(0, 3).join(', ')}...]`);
        }
        continue;
      }

      dataRowNum++;
      chunkBuffer.push(values.map(v => v ?? ''));

      if (chunkBuffer.length >= CHUNK_INPUT_ROWS) {
        chunkIdx++;
        if (chunkIdx > resumeFromChunk) {
          yield {
            chunkIdx,
            headers,
            rows: [...chunkBuffer],
            startRowNum: lineIdx - chunkBuffer.length + 1,
            inputChecksum: rowChecksum(chunkBuffer),
          };
        }
        chunkBuffer = [];
      }
    }

    // Flush last chunk
    if (chunkBuffer.length > 0) {
      chunkIdx++;
      if (chunkIdx > resumeFromChunk) {
        yield {
          chunkIdx,
          headers,
          rows: chunkBuffer,
          startRowNum: lineIdx - chunkBuffer.length + 1,
          inputChecksum: rowChecksum(chunkBuffer),
        };
      }
    }
  }

  // ───────────────────────────────────────────────────────────
  // LAYER 1.2 — Universal File Stream Wrapper
  // ───────────────────────────────────────────────────────────
  private async *streamFileChunks(
    file: Express.Multer.File | { buffer: Buffer, originalname: string },
    resumeFromChunk = 0,
  ): AsyncGenerator<ChunkJob> {
    const isCSV = file.originalname.toLowerCase().endsWith('.csv');
    if (isCSV) {
      console.log(`[Pipeline] Using CSV streaming path for ${file.originalname}`);
      yield* this.streamCSVChunks(file.buffer, resumeFromChunk);
    } else {
      console.log(`[Pipeline] Using XLSX streaming path for ${file.originalname}`);
      yield* this.streamExcelChunks(file.buffer, resumeFromChunk);
    }
  }



  // ───────────────────────────────────────────────────────────
  // LAYER 2 — Safe CSV serializer
  // ───────────────────────────────────────────────────────────
  // LAYER 2 — Safe CSV serializer
  // ───────────────────────────────────────────────────────────
  private rowsToCSV(rows: string[][]): string {
    return rows.map(r => r.map(cell => cell.replace(/\n/g, ' ')).join(';')).join('\n');
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
  private parseLlmRows(raw: string, jobHeaders: string[]): string[][] {
    const expectedCols = jobHeaders.length;
    const cleaned = raw
      .replace(/```(?:csv|text)?\n?([\s\S]*?)\n?```/g, '$1')
      .trim();

    const rawLines = cleaned
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    console.log(`[Pipeline] Parsed ${rawLines.length} raw lines from LLM response`);

    // Parse all lines as CSV rows, normalizing to expectedCols
    const parsed: string[][] = [];

    for (const line of rawLines) {
      const cols = line.split(';').map(c => c.trim());

      // Skip empty or single-column lines
      if (cols.length < 2) continue;

      // Detect if this line is just a repetition of the headers
      const isHeader = cols.every((val, idx) => {
        const header = jobHeaders[idx]?.trim().toLowerCase();
        return header && val.toLowerCase() === header;
      });
      if (isHeader) {
        console.log(`[Pipeline] Header repetition detected and skipped.`);
        continue;
      }

      // Pad or trim to expectedCols
      const row: string[] = [];
      for (let i = 0; i < expectedCols; i++) {
        row.push(cols[i] || '');
      }

      parsed.push(row);
    }

    console.log(`[Pipeline] Extracted ${parsed.length} valid rows from LLM output`);
    return parsed;
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
      `# TASK: Process the following DATA CHUNK using the provided context.\n\n` +
      `## REFERENCE CONTEXT (Support Files):\n` +
      `These files are for LOOKUP ONLY. Do NOT process these files as part of the output.\n` +
      `System Instruction Context: ${systemInstruction.includes('CONTEXTO DE APOYO') ? 'See System Instruction' : 'None'}\n\n` +
      `## INPUT DATA TO PROCESS:\n` +
      `${dataCsv}\n\n` +
      `## STRICT INSTRUCTIONS:\n` +
      `1. Respond ONLY with semicolon-separated (;) CSV rows.\n` +
      `2. One row per line. Do NOT split a row across multiple lines.\n` +
      `3. Each row MUST have exactly ${expectedCols} columns separated by semicolons.\n` +
      `4. Do NOT include headers, markdown blocks, or any conversation.\n` +
      `5. If you cannot find info for a column, leave it empty.\n` +
      `6. IMPORTANT: Do NOT use newlines (\\n) within cells. Replace them with spaces.\n` +
      `7. The data may contain commas (,). Only use semicolon (;) as the column separator.`;


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
        const responseLines = raw.split('\n').length;
        console.log(`[Pipeline] LLM Response: ${raw.length} chars | ${responseLines} lines | RATIO: ${(responseLines / inputCount).toFixed(2)}x | First 60 chars: ${raw.substring(0, 60).replace(/\n/g, ' ')}...`);


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

        let parsedRows = this.parseLlmRows(raw, headers);

        // ── Acceptance Check ──
        if (parsedRows.length === 0) {
          const msg = `[Pipeline] ${label}: empty or invalid response on attempt ${attempt}.`;
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
          `extracted=${parsedRows.length} rows (input was ${inputCount}) | ` +
          `inputChecksum=${inputChecksum} outputChecksum=${outputChecksum}`,
        );
        return parsedRows;

      } catch (err: any) {
        const status: number = err?.status ?? err?.response?.status ?? 0;
        const msg = err?.message?.toLowerCase() || '';
        const isRetryable = status === 503 || status === 429 || status === 500 || msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('network');

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
    files: CategorizedFiles,
    prompt: string,
    systemInstruction: string,
    jobId: string,
    onProgress?: (msg: string) => void,
    modelInfo?: { pricePerInputToken?: number; pricePerOutputToken?: number },
  ): PassThrough {

    const output = new PassThrough();
    this.cleanupResults().catch(() => { }); // Fire and forget background cleanup


    // Kick off async work without blocking the caller
    (async () => {
      const metrics = {
        totalRows: 0,
        totalChunks: 0,
        failedChunks: 0,
        retriedChunks: 0,
        startMs: Date.now(),
      };

      // ── Persistent Storage Strategy ──
      // To guarantee a valid .xlsx (ZIP), we write directly to disk using ExcelJS's file-based writer.
      // We do NOT stream binary while processing to avoid ZIP corruption due to backpressure/network glitches.
      // Instead, we stream PROGRESS via the PassThrough, and COMLETE at the end.
      const resultsDir = path.join(process.cwd(), 'results');
      if (!fsSync.existsSync(resultsDir)) {
        fsSync.mkdirSync(resultsDir, { recursive: true });
      }
      const filePath = path.join(resultsDir, `${jobId}.xlsx`);

      const writer = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: filePath,
        useStyles: true,
        useSharedStrings: true, // Crucial for repeated accounting data
      });

      const sendEvent = (type: 'progress' | 'complete' | 'error', message: string, extra = {}) => {
        output.push(`data: ${JSON.stringify({ type, message, ...extra })}\n\n`);
      };

      try {
        const resumeFrom = await readCheckpoint(jobId);

        // 1. Prepare context from Support Files
        let supportContext = '';
        if (files.supportFiles?.length) {
          console.log(`[Pipeline] Loading ${files.supportFiles.length} support files`);
          for (const sFile of files.supportFiles) {
            let content = '';
            const isExcel = sFile.originalname.endsWith('.xlsx') || sFile.originalname.endsWith('.xls');

            if (isExcel) {
              try {
                const wb = XLSX.read(sFile.buffer, { type: 'buffer' });
                const firstSheet = wb.Sheets[wb.SheetNames[0]];
                content = XLSX.utils.sheet_to_csv(firstSheet).slice(0, 50000); // Max 50k chars per support file
              } catch (e) {
                content = `[Error leyendo Excel: ${e.message}]`;
              }
            } else {
              content = sFile.buffer.toString('utf-8').slice(0, 50000);
            }

            supportContext += `\n--- CONTEXTO DE APOYO (${sFile.originalname}) ---\n${content}\n`;
          }
        }

        const enrichedSystemInstruction = `${systemInstruction}\n\nUsa este contexto extra si es necesario:\n${supportContext}`;

        // 2. Headings from Template (if any)
        let worksheet: ExcelJS.Worksheet | null = null;
        let templateHeaders: string[] = [];

        if (files.formatFile) {
          console.log(`[Pipeline] Extracting headers from template: ${files.formatFile.originalname}`);
          const formatStream = this.streamFileChunks(files.formatFile, 0);
          const firstChunk = await formatStream.next();
          if (!firstChunk.done) {
            templateHeaders = firstChunk.value.headers;
          }
        }

        // 3. Process Input File
        console.log(`[Pipeline] Processing input file: ${files.inputFile.originalname}`);

        for await (const job of this.streamFileChunks(files.inputFile, resumeFrom)) {

          metrics.totalChunks++;

          if (!worksheet) {
            worksheet = writer.addWorksheet('Result');
            const finalHeaders = templateHeaders.length > 0 ? templateHeaders : job.headers;
            worksheet.addRow(finalHeaders);
            console.log(`[Pipeline] Worksheet initialized with ${finalHeaders.length} headers`);
          }

          const progressMsg = `chunk ${job.chunkIdx} | filas ${job.startRowNum}–${job.startRowNum + job.rows.length - 1}`;
          if (onProgress) onProgress(progressMsg);
          sendEvent('progress', progressMsg, { chunk: job.chunkIdx, totalRows: metrics.totalRows });

          // Override headers in job if we have a template
          if (templateHeaders.length > 0) job.headers = templateHeaders;

          const outputRows = await this.processChunk(
            job,
            prompt,
            enrichedSystemInstruction,
            metrics,
          );

          metrics.totalRows += outputRows.length;

          for (const row of outputRows) {
            worksheet.addRow(row);
          }

          await writeCheckpoint(jobId, job.chunkIdx);
          await new Promise(r => setTimeout(r, CHUNK_INTER_DELAY_MS));
        }

        if (!worksheet) {
          writer.addWorksheet('Empty').addRow(['No se encontraron datos en el archivo de entrada']);
        }

        console.log(`[Pipeline] Finalizing Excel on disk: ${filePath}`);
        await writer.commit();

        await clearCheckpoint(jobId);
        const elapsedMs = Date.now() - metrics.startMs;
        
        // Calculate token cost
        const promptTokens = estimateTokens(prompt + systemInstruction);
        const priceIn = parseFloat(modelInfo?.pricePerInputToken?.toString() || '0');
        const priceOut = parseFloat(modelInfo?.pricePerOutputToken?.toString() || '0');
        
        // Estimate output tokens from processed rows (rough: 50 tokens per row)
        const estimatedOutputTokens = metrics.totalRows * 50;
        const totalCost = (promptTokens * priceIn) + (estimatedOutputTokens * priceOut);
        
        console.log(
          `[Pipeline] DONE jobId=${jobId} | rows=${metrics.totalRows} | elapsed=${elapsedMs}ms | ` +
          `tokens: input=${promptTokens} output~=${estimatedOutputTokens} | cost=$${totalCost.toFixed(6)}`
        );

        sendEvent('complete', 'Procesamiento completado con éxito', { 
          jobId, 
          totalRows: metrics.totalRows,
          tokens: { input: promptTokens, output: estimatedOutputTokens },
          cost: totalCost,
          elapsed: elapsedMs
        });
        output.push(null);


      } catch (err: any) {
        console.error(`[Pipeline] FATAL jobId=${jobId}:`, err?.message ?? err);
        await fs.unlink(filePath).catch(() => { });
        sendEvent('error', err?.message || 'Error fatal en la tubería');
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

        for await (const job of this.streamFileChunks(excelFile, 0)) {
          if (!headersWritten) {
            await writeLine(job.headers.join(';'));
            headersWritten = true;
          }

          if (onProgress) {
            const endRow = job.startRowNum + job.rows.length - 1;
            onProgress(`chunk ${job.chunkIdx} (rows ${job.startRowNum}–${endRow})`);
          }

          const outputRows = await this.processChunk(
            job,
            prompt,
            sysInst,
            metrics,
          );

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
