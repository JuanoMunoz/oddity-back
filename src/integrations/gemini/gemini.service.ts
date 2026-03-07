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
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as XLSX from 'xlsx';

const EXCEL_CHUNK_SIZE = 300;         // rows per chunk
const CHUNK_MAX_OUTPUT_TOKENS = 65000; // Increased for 300 rows to avoid truncation
const CHUNK_INTER_DELAY_MS = 2000;    // mandatory pause between chunks (avoid rate limits)
const FALLBACK_MODEL = 'gemini-2.5-flash-lite'; // used when primary model is unavailable

@Injectable()
export class GeminiService {
  private readonly model: string = 'gemini-2.5-flash';

  /** Default config for chat / general use */
  private readonly config: GenerateContentConfig = {
    thinkingConfig: { thinkingBudget: 0 },
    tools: [],
    temperature: 0,
    topP: 1,
    maxOutputTokens: 8192,
    safetySettings: [],
  };

  /** Tight config for each CSV chunk — deterministic, short budget */
  private readonly chunkConfig: GenerateContentConfig = {
    thinkingConfig: { thinkingBudget: 0 },
    tools: [],
    temperature: 0,
    topP: 1,
    maxOutputTokens: 15000,
    safetySettings: [],
  };

  constructor(
    @Inject(GEMINI_AI)
    private readonly ai: GoogleGenAI,
  ) { }

  // ─────────────────────────────────────────────
  // Public: ask (single prompt, no history)
  // ─────────────────────────────────────────────
  async ask(prompt: string, systemInstruction?: string) {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { ...this.config, systemInstruction: systemInstruction || '' },
    });
    return response;
  }

  // ─────────────────────────────────────────────
  // Public: chat (with history)
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // Helpers: Excel detection + AOA conversion
  // ─────────────────────────────────────────────
  private isExcelFile(file: Express.Multer.File): boolean {
    return (
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.mimetype === 'application/vnd.ms-excel'
    );
  }

  private excelToAOA(buffer: Buffer): { headers: string[]; rows: string[][] } {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const aoa: string[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    }) as string[][];

    const headers = (aoa[0] || []).map(String);
    const rows = aoa.slice(1).map(r => r.map(String));
    return { headers, rows };
  }

  private buildChunkCSV(headers: string[], rows: string[][]): string {
    return [headers.join(';'), ...rows.map(r => r.join(';'))].join('\n');
  }

  // ─────────────────────────────────────────────
  // Private: processChunk with exponential backoff
  // ─────────────────────────────────────────────
  private async processChunk(
    chunkCsv: string,
    prompt: string,
    systemInstruction: string,
    isFirstChunk: boolean,
    chunkLabel = '',
  ): Promise<string> {
    const chunkPrompt =
      `${prompt}\n\n---\nDATA CHUNK:\n${chunkCsv}\n---\n` +
      `IMPORTANT: Respond ONLY with semicolon-separated CSV rows. ` +
      `No markdown, no explanations, no preamble.` +
      (isFirstChunk
        ? ' Include the header row as the very first line.'
        : ' Do NOT include the header row in your response.');

    const contents: Content[] = [{
      role: 'user',
      parts: [{ text: chunkPrompt }],
    }];

    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 15000;
    let modelToUse = this.model;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.ai.models.generateContent({
          model: modelToUse,
          contents,
          config: { ...this.chunkConfig, systemInstruction },
        });
        const raw = (response.text || '').trim();
        // Remove code blocks and whitespace
        let cleaned = raw.replace(/```(?:csv|text)?\n?([\s\S]*?)\n?```/g, '$1').trim();

        // Ensure we handle semicolon splitting correctly if the AI uses comma
        if (!cleaned.includes(';') && cleaned.includes(',')) {
          cleaned = cleaned.replace(/,/g, ';');
        }

        if (!isFirstChunk) {
          // Robustly remove headers if the AI included them despite instructions
          const lines = cleaned.split('\n');
          if (lines.length > 0) {
            const firstLine = lines[0].toLowerCase();
            const csvHeadersPart = chunkCsv.split('\n')[0].toLowerCase().substring(0, 15);
            // If the first line of response matches the CSV headers (at least partially)
            if (firstLine.includes(csvHeadersPart)) {
              cleaned = lines.slice(1).join('\n').trim();
            }
          }
        }
        return cleaned;
      } catch (err: any) {
        const status: number = err?.status ?? err?.response?.status ?? 0;
        const isRetryable = status === 503 || status === 429 || status === 500;

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          if (attempt >= 2 && modelToUse === this.model) {
            modelToUse = FALLBACK_MODEL;
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
    throw new Error(`[Gemini] processChunk exhausted all retries`);
  }

  // ─────────────────────────────────────────────
  // Public: analyzeFilesChunked (Excel → chunks)
  // ─────────────────────────────────────────────
  async analyzeFilesChunked(
    files: Express.Multer.File[],
    prompt: string,
    systemInstruction?: string,
  ): Promise<{ text: string }> {
    const sysInst = systemInstruction || '';

    const excelFiles = files.filter(f => this.isExcelFile(f));
    const otherFiles = files.filter(f => !this.isExcelFile(f));

    if (excelFiles.length === 0) {
      const fallback = await this.analyzeFiles(files, prompt, sysInst);
      return { text: fallback.text ?? '' };
    }

    const allOutputParts: string[] = [];
    let isFirstChunkOverall = true;

    for (const excelFile of excelFiles) {
      const { headers, rows } = this.excelToAOA(excelFile.buffer);
      if (rows.length === 0) continue;

      const totalChunks = Math.ceil(rows.length / EXCEL_CHUNK_SIZE);

      for (let i = 0; i < rows.length; i += EXCEL_CHUNK_SIZE) {
        const chunkRows = rows.slice(i, i + EXCEL_CHUNK_SIZE);
        const chunkCsv = this.buildChunkCSV(headers, chunkRows);
        const chunkIdx = Math.floor(i / EXCEL_CHUNK_SIZE) + 1;
        const label = `chunk ${chunkIdx}/${totalChunks} (rows ${i + 1}-${Math.min(i + EXCEL_CHUNK_SIZE, rows.length)} of ${rows.length})`;

        console.log(`[Gemini] Processing ${label}`);

        const chunkResult = await this.processChunk(
          chunkCsv,
          prompt,
          sysInst,
          isFirstChunkOverall,
          label,
        );

        if (chunkResult) allOutputParts.push(chunkResult);
        isFirstChunkOverall = false;

        // Mandatory inter-chunk pause to avoid hammering the API
        if (i + EXCEL_CHUNK_SIZE < rows.length) {
          await new Promise(resolve => setTimeout(resolve, CHUNK_INTER_DELAY_MS));
        }
      }
    }

    // Process any non-Excel files normally and append
    if (otherFiles.length > 0) {
      const otherResult = await this.analyzeFiles(otherFiles, prompt, sysInst);
      if (otherResult.text) allOutputParts.push(otherResult.text);
    }

    return { text: allOutputParts.join('\n') };
  }

  // ─────────────────────────────────────────────
  // Public: analyzeFiles (upload to Gemini Files API)
  // ─────────────────────────────────────────────
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

        // Convert Excel to CSV before uploading
        if (this.isExcelFile(file)) {
          try {
            const workbook = XLSX.read(file.buffer, { type: 'buffer' });
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            const csvContent = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false, FS: ';' });
            finalBuffer = Buffer.from(csvContent);
            finalMimeType = 'text/csv';
            finalFileName = file.originalname.replace(/\.xlsx?$/, '.csv');
          } catch (excelErr) {
            console.error('Excel conversion failed, uploading original:', excelErr);
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
          throw new Error(`File upload failed for ${file.originalname}: missing properties.`);
        }
        uploadedFiles.push(fileUploaded);
      }

      // Wait for processing
      for (const fileUploaded of uploadedFiles) {
        let getFile = await this.ai.files.get({ name: fileUploaded.name });
        while (getFile.state === 'PROCESSING') {
          console.log(`Current file status (${fileUploaded.displayName}): ${getFile.state}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
          getFile = await this.ai.files.get({ name: fileUploaded.name });
        }
        if (getFile.state === 'FAILED') {
          throw new Error(`File processing failed for ${fileUploaded.displayName}.`);
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
      for (const tempPath of tempFilePaths) {
        await fs.unlink(tempPath).catch(() => { });
      }
    }
  }

  // ─────────────────────────────────────────────
  // Public: validateAccountingCSV
  // ─────────────────────────────────────────────
  validateAccountingCSV(text: string): { isValid: boolean; error?: string } {
    const cleanText = text.replace(/```(?:csv|text)?\n?([\s\S]*?)\n?```/g, '$1').trim();
    const lines = cleanText.split('\n').filter(line => line.trim() !== '');
    if (lines.length <= 1) return { isValid: true };

    // 1. Column count — 27 columns = 26 semicolons
    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i].split(';');
      if (cols.length !== 27) {
        return {
          isValid: false,
          error: `Fila ${i + 1} tiene ${cols.length} columnas, se esperaban 27. Contenido: ${lines[i].substring(0, 50)}...`,
        };
      }
    }

    // 2. Debits vs Credits per invoice
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
