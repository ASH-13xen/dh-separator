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
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

let parsedSyllabusText = '';

const loadSyllabus = async () => {
    try {
        const constantsDir = path.join(__dirname, '../constants');
        const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.js'));
        let syllabusStr = '';
        
        for (const file of files) {
          const filePath = path.join(constantsDir, file);
          const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
          const module = await import(modulePath);
          
          const exportKeys = Object.keys(module);
          for (const key of exportKeys) {
            const data = module[key];
            if (Array.isArray(data)) {
               if (file.startsWith('OptionalSubject')) {
                  const subjectName = file.replace('.js', '');
                  syllabusStr += `\n\n--- OPTIONAL SUBJECT: ${subjectName} ---\n`;
               } else if (file.startsWith('GS-')) {
                  syllabusStr += `\n\n--- COMPULSORY PAPER: ${file.replace('.js', '')} ---\n`;
               }
               
               data.forEach(sectionItem => {
                 if (sectionItem.section) {
                     syllabusStr += `Section: ${sectionItem.section}\n`;
                 }
                 if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
                   sectionItem.topics.forEach(topicItem => {
                     if (topicItem.title) {
                        syllabusStr += `  Topic: ${topicItem.title}\n`;
                        if (topicItem.subtopics) {
                           syllabusStr += `    Subtopics: ${topicItem.subtopics.join(', ')}\n`;
                        }
                     }
                   });
                 }
               });
            }
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
    const uploadResult = await fileManager.uploadFile(tempFilePath, {
      mimeType: 'application/pdf',
      displayName: `UPSC Complete Document`,
    });

    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    while (fileInfo.state === 'PROCESSING') {
      console.log(`[GeminiService] File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
    }

    const prompt = `You are an expert UPSC document classifier. 
Scan the attached document and identify every explicitly marked question. 
The PDF contains multiple distinct answer sheets merged together. Each sheet belongs to a different candidate. The start of a new sheet is denoted by a title or separator page.
Classify them STRICTLY according to the official UPSC syllabus provided below.

--- OFFICIAL UPSC SYLLABUS ---
${parsedSyllabusText}
------------------------------

For every question found, provide:
1. 'question_text': The exact full text of the question.
2. 'tags': A list of EXACT match string tags from the syllabus. Follow this strict hierarchy:
   - Exactly one GS paper tag (e.g., 'GS-1', 'GS-2', 'GS-3', 'GS-4').
   - Exactly one Section tag matching that GS paper.
   - Exactly one Topic Title tag matching that Section.
   - (Optional) Exactly one Optional Subject tag (e.g., 'OptionalSubjectHistory') if the question strongly indicates it.
3. 'start_page': The exact physical page number where it starts (Page 1 is the first page).
4. 'end_page': The exact physical page number where the answer ends.
5. 'answer_sheet_index': The 1-based index indicating which topper's answer sheet this question belongs to. The first answer sheet in the PDF is 1. When you see a title page for a new topper, increment this index for subsequent questions.

RULES:
- The 'tags' array must ONLY contain strings exactly matching the exact Section names, Topic titles, GS names, or OptionalSubject names defined in the syllabus context above. DO NOT invent tags.
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
    const result = await model.generateContent({
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
    });
    
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