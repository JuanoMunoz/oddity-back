import { GoogleGenAI } from "@google/genai";

export const ia = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, });

export const GEMINI_AI = Symbol('GEMINI_AI');