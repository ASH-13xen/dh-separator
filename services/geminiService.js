import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { PDFDocument } from 'pdf-lib';
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
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

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
        const hierarchyPath = path.join(__dirname, '../syllabus_hierarchy.json');
        if (!fs.existsSync(hierarchyPath)) {
            console.warn("[GeminiService] syllabus_hierarchy.json not found!");
            return;
        }
        
        const customData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
        let syllabusStr = '';
        
        if (customData.gsModules) {
          Object.entries(customData.gsModules).forEach(([moduleName, sections]) => {
            syllabusStr += `\n\n--- COMPULSORY PAPER: ${moduleName} ---\n`;
            if (Array.isArray(sections)) {
              sections.forEach(sectionItem => {
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
          });
        }
        
        if (customData.optionalSubjects) {
          Object.entries(customData.optionalSubjects).forEach(([subjectName, sections]) => {
            syllabusStr += `\n\n--- OPTIONAL SUBJECT: ${subjectName} ---\n`;
            if (Array.isArray(sections)) {
              sections.forEach(sectionItem => {
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
          });
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
  console.log(`[GeminiService] [processQuesPdfWithGemini] Starting process. Buffer size: ${pdfBuffer ? pdfBuffer.length : 0} bytes. Temp file path: ${tempFilePath}`);
  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);
    console.log(`[GeminiService] [processQuesPdfWithGemini] Temp file written successfully.`);
    
    console.log(`[GeminiService] [processQuesPdfWithGemini] Uploading file to Google AI...`);
    let uploadResult;
    try {
      uploadResult = await withRetry(() => fileManager.uploadFile(tempFilePath, {
        mimeType: 'application/pdf',
        displayName: `QuesPDF Document`,
      }), 3, 3000);
      console.log(`[GeminiService] [processQuesPdfWithGemini] Upload complete. File Name: ${uploadResult.file.name}, URI: ${uploadResult.file.uri}`);
    } catch (uploadError) {
      console.error(`[GeminiService] [processQuesPdfWithGemini] Upload failed:`, uploadError);
      if (uploadError.message && uploadError.message.includes('User location is not supported')) {
        throw new Error('LOCATION_NOT_SUPPORTED');
      }
      throw uploadError;
    }

    console.log(`[GeminiService] [processQuesPdfWithGemini] Retrieving initial file info for: ${uploadResult.file.name}`);
    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    console.log(`[GeminiService] [processQuesPdfWithGemini] Initial state: ${fileInfo.state}`);
    while (fileInfo.state === 'PROCESSING') {
      console.log(`[GeminiService] [processQuesPdfWithGemini] QuesPDF File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
      console.log(`[GeminiService] [processQuesPdfWithGemini] Polled state: ${fileInfo.state}`);
    }

    if (fileInfo.state === 'FAILED') {
      console.error(`[GeminiService] [processQuesPdfWithGemini] File processing state is FAILED on Gemini's servers.`);
      throw new Error(`File processing failed on Gemini's servers for file: ${uploadResult.file.name}`);
    }

    console.log(`[GeminiService] [processQuesPdfWithGemini] File is ready. Prompting Gemini model...`);
    const prompt = `You are an expert UPSC document analyzer.
Scan the attached answer sheet PDF page-by-page.
For each physical page (1-based index, starting from Page 1):
1. Detect if there is a printed or written question on this page. Note that a question is typically at the top of the page.
2. If a question is present on this page, extract the FULL text of the question.
3. Return a JSON array where each item represents a question found on a page.

CRITICAL RULES FOR LANGUAGES:
- IGNORE ALL Hindi text/characters and any other non-English languages. Keep ONLY English text.
- If a question is bilingual (printed in both Hindi and English), extract ONLY the English portion of the question and completely ignore the Hindi translation/characters.
- Ensure the extracted question text contains ONLY standard English alphanumeric characters, punctuation, and whitespace.

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

    console.log(`[GeminiService] [processQuesPdfWithGemini] Initializing QuesPDF AI analysis request...`);
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
    
    console.log(`[GeminiService] [processQuesPdfWithGemini] Gemini AI analysis completed. Parsing response...`);
    const responseText = result.response.text();
    console.log(`[GeminiService] [processQuesPdfWithGemini] Raw response text length: ${responseText ? responseText.length : 0} characters.`);
    console.log(`[GeminiService] [processQuesPdfWithGemini] Raw response text sample: ${responseText ? responseText.substring(0, 500) : ''}`);
    const jsonArray = JSON.parse(responseText);
    console.log(`[GeminiService] [processQuesPdfWithGemini] Parsed JSON successfully. Found ${jsonArray ? jsonArray.length : 0} questions.`);
    
    // Clean up
    console.log(`[GeminiService] [processQuesPdfWithGemini] Deleting uploaded file from Google AI Storage...`);
    try { 
      await fileManager.deleteFile(uploadResult.file.name); 
      console.log(`[GeminiService] [processQuesPdfWithGemini] Google AI file deleted successfully.`);
    } catch (e) {
      console.warn(`[GeminiService] [processQuesPdfWithGemini] Non-fatal error deleting file from Google AI Storage:`, e.message);
    }
    
    return jsonArray;
  } catch (error) {
    console.error("[GeminiService] [processQuesPdfWithGemini] QuesPDF Error:", error);
    throw error;
  } finally {
    if (fs.existsSync(tempFilePath)) {
      console.log(`[GeminiService] [processQuesPdfWithGemini] Cleaning up local temp file: ${tempFilePath}`);
      fs.unlinkSync(tempFilePath);
    }
  }
};

export const processQuesPdfInChunks = async (pdfBuffer, chunkPageCount = 100, startPageParam = 1, endPageParam = null) => {
  console.log(`[GeminiService] [processQuesPdfInChunks] Starting chunked PDF process. Buffer size: ${pdfBuffer ? pdfBuffer.length : 0} bytes. Chunk size: ${chunkPageCount} pages. Custom Range: ${startPageParam} to ${endPageParam || 'end'}`);
  try {
    const mainPdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = mainPdfDoc.getPageCount();
    console.log(`[GeminiService] [processQuesPdfInChunks] Total pages in source PDF: ${totalPages}`);

    const startPage = Math.max(1, parseInt(startPageParam) || 1);
    const endPage = Math.min(totalPages, parseInt(endPageParam) || totalPages);
    console.log(`[GeminiService] [processQuesPdfInChunks] Targeted operation range: Page ${startPage} to Page ${endPage}`);

    const allQuestions = [];

    for (let chunkStart = startPage; chunkStart <= endPage; chunkStart += chunkPageCount) {
      const chunkEnd = Math.min(chunkStart + chunkPageCount - 1, endPage);
      console.log(`[GeminiService] [processQuesPdfInChunks] Processing chunk: pages ${chunkStart} to ${chunkEnd} (${chunkEnd - chunkStart + 1} pages)`);

      // Create a sub-pdf for this chunk
      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from({ length: chunkEnd - chunkStart + 1 }, (_, index) => chunkStart - 1 + index);
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();

      // Process this chunk with Gemini
      const chunkQuestions = await processQuesPdfWithGemini(Buffer.from(subPdfBytes));

      if (chunkQuestions && Array.isArray(chunkQuestions)) {
        console.log(`[GeminiService] [processQuesPdfInChunks] Chunk (pages ${chunkStart}-${chunkEnd}) returned ${chunkQuestions.length} questions.`);
        for (const q of chunkQuestions) {
          // Adjust page number relative to the original document:
          // The page number returned from Gemini is relative to the sub-PDF chunk (1-based index).
          const absolutePageNumber = chunkStart + q.page_number - 1;
          console.log(`[GeminiService] [processQuesPdfInChunks] Mapping page_number ${q.page_number} in chunk to absolute page_number ${absolutePageNumber}`);
          allQuestions.push({
            page_number: Math.min(absolutePageNumber, totalPages),
            question_text: q.question_text
          });
        }
      } else {
        console.warn(`[GeminiService] [processQuesPdfInChunks] Chunk (pages ${chunkStart}-${chunkEnd}) returned no valid questions list.`);
      }
    }

    // Sort by page_number to ensure sequence
    allQuestions.sort((a, b) => a.page_number - b.page_number);
    console.log(`[GeminiService] [processQuesPdfInChunks] Finished processing all chunks. Consolidated questions count: ${allQuestions.length}`);
    return allQuestions;
  } catch (error) {
    console.error("[GeminiService] [processQuesPdfInChunks] Error in chunked PDF processing:", error);
    throw error;
  }
};

export const processLargePdfInChunks = async (pdfBuffer, chunkPageCount = 50, forceContinuity = true) => {
  try {
    const mainPdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    console.log(`[GeminiService] Splitting large PDF (${totalPages} pages) into chunks of ${chunkPageCount} pages...`);
    const allQuestions = [];

    for (let startPage = 1; startPage <= totalPages; startPage += chunkPageCount) {
      const endPage = Math.min(startPage + chunkPageCount - 1, totalPages);
      console.log(`[GeminiService] Processing chunk: pages ${startPage} to ${endPage}`);

      // Create a sub-pdf for this chunk
      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from({ length: endPage - startPage + 1 }, (_, index) => startPage - 1 + index);
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();

      // Process this chunk with Gemini
      const chunkQuestions = await processEntirePdfWithGemini(Buffer.from(subPdfBytes));

      if (chunkQuestions && Array.isArray(chunkQuestions)) {
        for (const q of chunkQuestions) {
          const absStart = startPage + q.start_page - 1;
          const absEnd = startPage + q.end_page - 1;

          allQuestions.push({
            question_text: q.question_text,
            tags: q.tags || [],
            start_page: Math.min(absStart, totalPages),
            end_page: Math.min(absEnd, totalPages),
            answer_sheet_index: q.answer_sheet_index || 1
          });
        }
      }
    }

    // Sort by start_page to ensure sequence
    allQuestions.sort((a, b) => a.start_page - b.start_page);

    if (forceContinuity) {
      // Clean up end pages to ensure continuity
      for (let i = 0; i < allQuestions.length; i++) {
        if (i < allQuestions.length - 1) {
          allQuestions[i].end_page = allQuestions[i + 1].start_page - 1;
        } else {
          allQuestions[i].end_page = totalPages;
        }

        if (allQuestions[i].end_page < allQuestions[i].start_page) {
          allQuestions[i].end_page = allQuestions[i].start_page;
        }
      }
    }

    console.log(`[GeminiService] Batched processing complete. Found ${allQuestions.length} total questions.`);
    return allQuestions;
  } catch (error) {
    console.error("[GeminiService] Error in processLargePdfInChunks:", error);
    throw error;
  }
};

export const getSubjectSyllabusText = (subject) => {
  try {
    const hierarchyPath = path.join(__dirname, '../syllabus_hierarchy.json');
    if (!fs.existsSync(hierarchyPath)) {
      console.warn("[GeminiService] syllabus_hierarchy.json not found!");
      return '';
    }
    
    const customData = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
    let syllabusStr = '';
    
    let finalSubject = subject;
    if (!finalSubject.startsWith('GS-') && !finalSubject.startsWith('OptionalSubject')) {
       const cleanName = finalSubject.replace(/\s+/g, '');
       finalSubject = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
    }

    if (finalSubject.startsWith('GS-')) {
      const sections = customData.gsModules?.[finalSubject] || [];
      syllabusStr += `--- COMPULSORY PAPER: ${finalSubject} ---\n`;
      sections.forEach(sectionItem => {
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
    } else {
      const sections = customData.optionalSubjects?.[finalSubject] || [];
      syllabusStr += `--- OPTIONAL SUBJECT: ${finalSubject} ---\n`;
      sections.forEach(sectionItem => {
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
    
    return syllabusStr;
  } catch (e) {
    console.error("Failed to load subject syllabus:", e);
    return '';
  }
};

export const tagQuestionWithGemini = async (questionText, subject) => {
  try {
    const syllabusText = getSubjectSyllabusText(subject);
    const prompt = `You are an expert UPSC question classifier.
Analyze the following question text:
"${questionText}"

Your task is to assign the correct tags to this question strictly based on the syllabus hierarchy of the subject: ${subject}.

--- SUBJECT SYLLABUS ---
${syllabusText}
------------------------

Provide the tags as a JSON object with a single property 'tags', which is a list of EXACT match string tags from the syllabus.
Follow this strict hierarchy:
If the subject is a Compulsory Paper (GS, e.g. GS-1, GS-2, GS-3, GS-4):
- Include the GS paper tag (e.g., '${subject}').
- Include exactly ONE Section tag matching that GS paper.
- Include exactly ONE Topic Title tag matching that Section.
If the subject is an Optional Subject (e.g. OptionalSubjectAnthropology):
- Include the Optional Subject tag (e.g., '${subject}').
- Include exactly ONE paper tag, which MUST be either "Paper 1" or "Paper 2".
- Include exactly ONE Section tag matching that Optional Subject.
- Include exactly ONE Topic Title tag matching that Section.

Note: The tags MUST match the names/titles in the syllabus hierarchy EXACTLY. Do not invent tags.
Return ONLY a JSON object matching this schema:
{
  "tags": ["tag1", "tag2", "tag3"]
}
`;

    const responseSchema = {
      type: SchemaType.OBJECT,
      properties: {
        tags: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "List of exactly matched syllabus tags representing subject, paper, section, and topic."
        }
      },
      required: ["tags"]
    };

    console.log(`[GeminiService] Assigning tags for question: "${questionText.substring(0, 40)}..."`);
    const result = await withRetry(() => model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
        temperature: 0.0
      }
    }), 3, 3000);

    const responseText = result.response.text();
    const jsonResult = JSON.parse(responseText);
    return jsonResult.tags || [];
  } catch (error) {
    console.error("[GeminiService] Error in tagQuestionWithGemini:", error);
    return [];
  }
};

