import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });

let parsedSyllabusText = '';

const withRetry = async (fn, retries = 3, delayMs = 5000) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      console.warn(`[GeminiService] Attempt ${attempt} failed: ${error.message}`);
      if (attempt >= retries) {
        throw error;
      }
      console.log(`[GeminiService] Waiting ${delayMs}ms before retrying...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      delayMs *= 2; // Exponential backoff
    }
  }
};

const loadSyllabus = async () => {
    try {
        const constantsDir = path.join(__dirname, '../constants');
        const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.json') && f !== 'customHierarchy.json');
        let syllabusStr = '';
        
        for (const file of files) {
          const filePath = path.join(constantsDir, file);
          let data = [];
          try {
            data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          } catch (err) {
            console.error(`Error parsing JSON file ${file} in loadSyllabus:`, err);
            continue;
          }
          
          if (Array.isArray(data)) {
             if (file.startsWith('OptionalSubject')) {
                const subjectName = file.replace('.json', '');
                syllabusStr += `\n\n--- OPTIONAL SUBJECT: ${subjectName} ---\n`;
             } else if (file.startsWith('GS-')) {
                syllabusStr += `\n\n--- COMPULSORY PAPER: ${file.replace('.json', '')} ---\n`;
             }
             
             data.forEach(sectionItem => {
               if (sectionItem.section) {
                   syllabusStr += `Section: ${sectionItem.section}\n`;
               }
               if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
                 sectionItem.topics.forEach(topicItem => {
                   if (topicItem.title) {
                      syllabusStr += `  Topic: ${topicItem.title}\n`;
                      if (topicItem.subtopics && Array.isArray(topicItem.subtopics)) {
                         syllabusStr += `    Subtopics: ${topicItem.subtopics.join(', ')}\n`;
                      }
                   }
                 });
               }
             });
          }
        }
        parsedSyllabusText = syllabusStr;
    } catch (e) {
        console.error("Failed to load dynamic syllabus:", e);
    }
};

loadSyllabus();

export const processEntirePdfWithGemini = async (pdfBuffer) => {
  const tempFilePath = path.join(os.tmpdir(), `full-doc-${Date.now()}.pdf`);

  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);
    
    console.log(`[GeminiService] Uploading file to Google AI...`);
    
    let uploadResult;
    try {
      uploadResult = await withRetry(() => fileManager.uploadFile(tempFilePath, {
        mimeType: 'application/pdf',
        displayName: `UPSC Complete Document`,
      }), 3, 3000);
    } catch (uploadError) {
      if (uploadError.message && uploadError.message.includes('User location is not supported')) {
        throw new Error('LOCATION_NOT_SUPPORTED');
      }
      throw uploadError;
    }

    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    while (fileInfo.state === 'PROCESSING') {
      console.log(`[GeminiService] File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
    }

    if (fileInfo.state === 'FAILED') {
      throw new Error(`File processing failed on Gemini's servers for file: ${uploadResult.file.name}`);
    }

    const prompt = `You are an expert UPSC document classifier. 
Scan the attached document and identify every explicitly marked question. 
The PDF contains multiple distinct answer sheets merged together. Each sheet belongs to a different candidate. The start of a new sheet is denoted by a title or separator page.

CRITICAL INSTRUCTIONS FOR PDF READING:
- The PDF is an answer sheet with handwritten answers and computer text questions.
- Read the PDF page by page.
- Whenever you find a question type text, ONLY then consider it as a question.
- Create the answer starting from that question page until the next question comes.
- Include the question page as well in the answer range.
- The questions can be a little blurry, so take that into consideration and try your best to read them.
- The PDF may contain a topper's name and details pages; IGNORE these pages.
- The questions are typically printed in TEXT format (not handwritten) and start with indicators like "Q1", "Q.1", "Question 1", etc. Use these text indicators to confidently find the start of a question.
- For the 'end_page' of a question, it MUST include all pages until the exact page where the NEXT printed question (e.g., "Q2") starts (or until the end of the current answer sheet). Take everything in between as the solution.

Classify them STRICTLY according to the official UPSC syllabus provided below.

--- OFFICIAL UPSC SYLLABUS ---
${parsedSyllabusText}
------------------------------

For every question found, provide:
1. 'question_text': The exact full text of the question.
2. 'tags': A list of EXACT match string tags from the syllabus. Follow this strict hierarchy:
   If the question is from a Compulsory Paper (GS):
   - Exactly ONE GS paper tag (e.g., 'GS-1', 'GS-2', 'GS-3', 'GS-4').
   - Exactly ONE Section tag matching that GS paper.
   - Exactly ONE Topic Title tag matching that Section.
   If the question is from an Optional Subject:
   - Exactly ONE Optional Subject tag (e.g., 'OptionalSubjectHistory').
   - Exactly ONE paper tag, which MUST be either "Paper 1" or "Paper 2".
   - Exactly ONE Section tag matching that Optional Subject.
   - Exactly ONE Topic Title tag matching that Section.
   Note: A question can have both GS tags and Optional Subject tags if relevant.
3. 'start_page': The exact physical page number where the question starts (Page 1 is the first page).
4. 'end_page': The exact physical page number where the solution ends (which is just before the next question starts).
5. 'answer_sheet_index': The 1-based index indicating which topper's answer sheet this question belongs to. The first answer sheet in the PDF is 1. When you see a title page for a new topper, increment this index for subsequent questions.

RULES:
- The 'tags' array must ONLY contain strings exactly matching the exact Section names, Topic titles, GS names, or OptionalSubject names defined in the syllabus context above. DO NOT invent tags.
- NEVER return more than one GS tag or more than one Optional Subject tag for a single question.
- A question should ideally be classified under either a GS Paper or an Optional Subject, with its corresponding Section and Topic.
- Return ONLY a JSON array.`;

    const responseSchema = {
      type: SchemaType.ARRAY,
      description: "Array of classified questions",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          question_text: { type: SchemaType.STRING },
          tags: { 
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "Array of exactly matched syllabus tags representing GS, Section, Topic, and optionally OptionalSubject."
          },
          start_page: { type: SchemaType.INTEGER },
          end_page: { type: SchemaType.INTEGER },
          answer_sheet_index: { 
            type: SchemaType.INTEGER,
            description: "The 1-based index of the answer sheet this question belongs to."
          }
        },
        required: ["question_text", "tags", "start_page", "end_page", "answer_sheet_index"]
      }
    };

    console.log(`[GeminiService] Initializing AI analysis...`);
    const result = await withRetry(() => model.generateContent({
      contents: [{ 
        role: 'user', 
        parts: [
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: prompt }
        ] 
      }],
      generationConfig: { 
        responseMimeType: "application/json", 
        responseSchema: responseSchema, 
        temperature: 0.0 // Keep this at 0.0 for maximum consistency
      }
    }), 4, 5000); // 4 retries, starting with 5 seconds
    
    const responseText = result.response.text();
    const jsonArray = JSON.parse(responseText);
    
    // Clean up
    try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) {}
    
    return jsonArray;

  } catch (error) {
    console.error("[GeminiService] Error:", error);
    throw error;
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
};

export const processQuesPdfWithGemini = async (pdfBuffer) => {
  const tempFilePath = path.join(os.tmpdir(), `ques-doc-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);
    
    console.log(`[GeminiService] Uploading file for QuesPDF to Google AI...`);
    let uploadResult;
    try {
      uploadResult = await withRetry(() => fileManager.uploadFile(tempFilePath, {
        mimeType: 'application/pdf',
        displayName: `QuesPDF Document`,
      }), 3, 3000);
    } catch (uploadError) {
      if (uploadError.message && uploadError.message.includes('User location is not supported')) {
        throw new Error('LOCATION_NOT_SUPPORTED');
      }
      throw uploadError;
    }

    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    while (fileInfo.state === 'PROCESSING') {
      console.log(`[GeminiService] QuesPDF File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
    }

    if (fileInfo.state === 'FAILED') {
      throw new Error(`File processing failed on Gemini's servers for file: ${uploadResult.file.name}`);
    }

    const prompt = `You are an expert UPSC document analyzer.
Scan the attached answer sheet PDF page-by-page.
For each physical page (1-based index, starting from Page 1):
1. Detect if there is a printed or written question on this page. Note that a question is typically at the top of the page.
2. If a question is present on this page, extract the FULL text of the question exactly as written or printed.
3. Return a JSON array where each item represents a question found on a page.

CRITICAL RULES:
- The PDF contains text questions and handwritten answers.
- Scan every single page. Do not skip any page.
- For each page, if there is a question, include it in the returned array with its "page_number" and "question_text".
- If a page has NO question (only handwritten answer text continuing from a previous page, or blank), do NOT include an entry for that page in the JSON array.
- Return ONLY the JSON array matching the schema.`;

    const responseSchema = {
      type: SchemaType.ARRAY,
      description: "Array of extracted questions with page numbers",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          page_number: { 
            type: SchemaType.INTEGER,
            description: "The 1-based page number where this question is found."
          },
          question_text: { 
            type: SchemaType.STRING,
            description: "The full exact text of the question extracted from the page."
          }
        },
        required: ["page_number", "question_text"]
      }
    };

    console.log(`[GeminiService] Initializing QuesPDF AI analysis...`);
    const result = await withRetry(() => model.generateContent({
      contents: [{ 
        role: 'user', 
        parts: [
          { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uploadResult.file.uri } },
          { text: prompt }
        ] 
      }],
      generationConfig: { 
        responseMimeType: "application/json", 
        responseSchema: responseSchema, 
        temperature: 0.0 // Keep at 0 for maximum consistency
      }
    }), 4, 5000);
    
    const responseText = result.response.text();
    const jsonArray = JSON.parse(responseText);
    
    // Clean up
    try { await fileManager.deleteFile(uploadResult.file.name); } catch (e) {}
    
    return jsonArray;
  } catch (error) {
    console.error("[GeminiService] QuesPDF Error:", error);
    throw error;
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
  }
};