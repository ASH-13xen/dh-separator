import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = new GoogleGenerativeAI(apiKey);
const fileManager = new GoogleAIFileManager(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const withRetry = async (fn, retries = 3, delayMs = 5000) => {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      console.warn(
        `[GeminiService] Attempt ${attempt} failed: ${error.message}`,
      );
      if (attempt >= retries) {
        throw error;
      }
      console.log(`[GeminiService] Waiting ${delayMs}ms before retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2; // Exponential backoff
    }
  }
};

// Strips a leading question-number marker (e.g. "Q.12)", "Q 12)", "Question 12:") and any
// trailing marks/word-count annotation (e.g. "(15 marks, 250 words)", "[10 Marks]") from
// extracted question text. Gemini is also instructed to omit these in the prompt, but this
// regex pass enforces it strictly regardless of how Gemini formats its output.
function cleanQuestionText(text) {
  if (!text) return text;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^(?:Q\.?\s*\d+\)?|Question\s*\d+)[.):\s-]*/i, '');
  let prevLength;
  do {
    prevLength = cleaned.length;
    cleaned = cleaned.replace(/\s*[([][^()[\]]*\b(?:marks?|words?)\b[^()[\]]*[)\]]\s*$/i, '');
  } while (cleaned.length !== prevLength);
  return cleaned.trim();
}

export const processEntirePdfWithGemini = async (pdfBuffer) => {
  const tempFilePath = path.join(os.tmpdir(), `full-doc-${Date.now()}.pdf`);

  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);

    console.log(`[GeminiService] Uploading file to Google AI...`);

    let uploadResult;
    try {
      uploadResult = await withRetry(
        () =>
          fileManager.uploadFile(tempFilePath, {
            mimeType: "application/pdf",
            displayName: `UPSC Complete Document`,
          }),
        3,
        3000,
      );
    } catch (uploadError) {
      if (
        uploadError.message &&
        uploadError.message.includes("User location is not supported")
      ) {
        throw new Error("LOCATION_NOT_SUPPORTED");
      }
      throw uploadError;
    }

    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    while (fileInfo.state === "PROCESSING") {
      console.log(`[GeminiService] File is processing... waiting 5 seconds.`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
    }

    if (fileInfo.state === "FAILED") {
      throw new Error(
        `File processing failed on Gemini's servers for file: ${uploadResult.file.name}`,
      );
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

For every question found, provide:
1. 'question_text': The full text of the question, EXCLUDING the leading question number marker (e.g. "Q.12)", "Q 12)", "Question 12:") and EXCLUDING any trailing marks/word-count annotation (e.g. "(15 marks, 250 words)", "[10 Marks]"). Only the question's actual wording.
2. 'start_page': The exact physical page number where the question starts (Page 1 is the first page).
3. 'end_page': The exact physical page number where the solution ends (which is just before the next question starts).
4. 'answer_sheet_index': The 1-based index indicating which topper's answer sheet this question belongs to. The first answer sheet in the PDF is 1. When you see a title page for a new topper, increment this index for subsequent questions.

RULES:
- Return ONLY a JSON array.`;

    const responseSchema = {
      type: SchemaType.ARRAY,
      description: "Array of classified questions",
      items: {
        type: SchemaType.OBJECT,
        properties: {
          question_text: { type: SchemaType.STRING },
          start_page: { type: SchemaType.INTEGER },
          end_page: { type: SchemaType.INTEGER },
          answer_sheet_index: {
            type: SchemaType.INTEGER,
            description:
              "The 1-based index of the answer sheet this question belongs to.",
          },
        },
        required: [
          "question_text",
          "start_page",
          "end_page",
          "answer_sheet_index",
        ],
      },
    };

    console.log(`[GeminiService] Initializing AI analysis...`);
    const result = await withRetry(
      () =>
        model.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    mimeType: uploadResult.file.mimeType,
                    fileUri: uploadResult.file.uri,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.0, // Keep this at 0.0 for maximum consistency
          },
        }),
      4,
      5000,
    ); // 4 retries, starting with 5 seconds

    const responseText = result.response.text();
    const jsonArray = JSON.parse(responseText);

    // Clean up
    try {
      await fileManager.deleteFile(uploadResult.file.name);
    } catch (e) {}

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
  console.log(
    `[GeminiService] [processQuesPdfWithGemini] Starting process. Buffer size: ${pdfBuffer ? pdfBuffer.length : 0} bytes. Temp file path: ${tempFilePath}`,
  );
  try {
    fs.writeFileSync(tempFilePath, pdfBuffer);
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Temp file written successfully.`,
    );

    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Uploading file to Google AI...`,
    );
    let uploadResult;
    try {
      uploadResult = await withRetry(
        () =>
          fileManager.uploadFile(tempFilePath, {
            mimeType: "application/pdf",
            displayName: `QuesPDF Document`,
          }),
        3,
        3000,
      );
      console.log(
        `[GeminiService] [processQuesPdfWithGemini] Upload complete. File Name: ${uploadResult.file.name}, URI: ${uploadResult.file.uri}`,
      );
    } catch (uploadError) {
      console.error(
        `[GeminiService] [processQuesPdfWithGemini] Upload failed:`,
        uploadError,
      );
      if (
        uploadError.message &&
        uploadError.message.includes("User location is not supported")
      ) {
        throw new Error("LOCATION_NOT_SUPPORTED");
      }
      throw uploadError;
    }

    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Retrieving initial file info for: ${uploadResult.file.name}`,
    );
    let fileInfo = await fileManager.getFile(uploadResult.file.name);
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Initial state: ${fileInfo.state}`,
    );
    while (fileInfo.state === "PROCESSING") {
      console.log(
        `[GeminiService] [processQuesPdfWithGemini] QuesPDF File is processing... waiting 5 seconds.`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
      fileInfo = await fileManager.getFile(uploadResult.file.name);
      console.log(
        `[GeminiService] [processQuesPdfWithGemini] Polled state: ${fileInfo.state}`,
      );
    }

    if (fileInfo.state === "FAILED") {
      console.error(
        `[GeminiService] [processQuesPdfWithGemini] File processing state is FAILED on Gemini's servers.`,
      );
      throw new Error(
        `File processing failed on Gemini's servers for file: ${uploadResult.file.name}`,
      );
    }

    console.log(
      `[GeminiService] [processQuesPdfWithGemini] File is ready. Prompting Gemini model...`,
    );
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
            description:
              "The 1-based page number where this question is found.",
          },
          question_text: {
            type: SchemaType.STRING,
            description:
              "The full exact text of the question extracted from the page.",
          },
        },
        required: ["page_number", "question_text"],
      },
    };

    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Initializing QuesPDF AI analysis request...`,
    );
    const result = await withRetry(
      () =>
        model.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    mimeType: uploadResult.file.mimeType,
                    fileUri: uploadResult.file.uri,
                  },
                },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.0, // Keep at 0 for maximum consistency
          },
        }),
      4,
      5000,
    );

    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Gemini AI analysis completed. Parsing response...`,
    );
    const responseText = result.response.text();
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Raw response text length: ${responseText ? responseText.length : 0} characters.`,
    );
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Raw response text sample: ${responseText ? responseText.substring(0, 500) : ""}`,
    );
    const jsonArray = JSON.parse(responseText);
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Parsed JSON successfully. Found ${jsonArray ? jsonArray.length : 0} questions.`,
    );

    // Clean up
    console.log(
      `[GeminiService] [processQuesPdfWithGemini] Deleting uploaded file from Google AI Storage...`,
    );
    try {
      await fileManager.deleteFile(uploadResult.file.name);
      console.log(
        `[GeminiService] [processQuesPdfWithGemini] Google AI file deleted successfully.`,
      );
    } catch (e) {
      console.warn(
        `[GeminiService] [processQuesPdfWithGemini] Non-fatal error deleting file from Google AI Storage:`,
        e.message,
      );
    }

    return jsonArray;
  } catch (error) {
    console.error(
      "[GeminiService] [processQuesPdfWithGemini] QuesPDF Error:",
      error,
    );
    throw error;
  } finally {
    if (fs.existsSync(tempFilePath)) {
      console.log(
        `[GeminiService] [processQuesPdfWithGemini] Cleaning up local temp file: ${tempFilePath}`,
      );
      fs.unlinkSync(tempFilePath);
    }
  }
};

export const processQuesPdfInChunks = async (
  pdfBuffer,
  chunkPageCount = 100,
  startPageParam = 1,
  endPageParam = null,
) => {
  console.log(
    `[GeminiService] [processQuesPdfInChunks] Starting chunked PDF process. Buffer size: ${pdfBuffer ? pdfBuffer.length : 0} bytes. Chunk size: ${chunkPageCount} pages. Custom Range: ${startPageParam} to ${endPageParam || "end"}`,
  );
  try {
    const mainPdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = mainPdfDoc.getPageCount();
    console.log(
      `[GeminiService] [processQuesPdfInChunks] Total pages in source PDF: ${totalPages}`,
    );

    const startPage = Math.max(1, parseInt(startPageParam) || 1);
    const endPage = Math.min(totalPages, parseInt(endPageParam) || totalPages);
    console.log(
      `[GeminiService] [processQuesPdfInChunks] Targeted operation range: Page ${startPage} to Page ${endPage}`,
    );

    const allQuestions = [];

    for (
      let chunkStart = startPage;
      chunkStart <= endPage;
      chunkStart += chunkPageCount
    ) {
      const chunkEnd = Math.min(chunkStart + chunkPageCount - 1, endPage);
      console.log(
        `[GeminiService] [processQuesPdfInChunks] Processing chunk: pages ${chunkStart} to ${chunkEnd} (${chunkEnd - chunkStart + 1} pages)`,
      );

      // Create a sub-pdf for this chunk
      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from(
        { length: chunkEnd - chunkStart + 1 },
        (_, index) => chunkStart - 1 + index,
      );
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();

      // Process this chunk with Gemini
      const chunkQuestions = await processQuesPdfWithGemini(
        Buffer.from(subPdfBytes),
      );

      if (chunkQuestions && Array.isArray(chunkQuestions)) {
        console.log(
          `[GeminiService] [processQuesPdfInChunks] Chunk (pages ${chunkStart}-${chunkEnd}) returned ${chunkQuestions.length} questions.`,
        );
        for (const q of chunkQuestions) {
          // Adjust page number relative to the original document:
          // The page number returned from Gemini is relative to the sub-PDF chunk (1-based index).
          const absolutePageNumber = chunkStart + q.page_number - 1;
          console.log(
            `[GeminiService] [processQuesPdfInChunks] Mapping page_number ${q.page_number} in chunk to absolute page_number ${absolutePageNumber}`,
          );
          allQuestions.push({
            page_number: Math.min(absolutePageNumber, totalPages),
            question_text: q.question_text,
          });
        }
      } else {
        console.warn(
          `[GeminiService] [processQuesPdfInChunks] Chunk (pages ${chunkStart}-${chunkEnd}) returned no valid questions list.`,
        );
      }
    }

    // Sort by page_number to ensure sequence
    allQuestions.sort((a, b) => a.page_number - b.page_number);
    console.log(
      `[GeminiService] [processQuesPdfInChunks] Finished processing all chunks. Consolidated questions count: ${allQuestions.length}`,
    );
    return allQuestions;
  } catch (error) {
    console.error(
      "[GeminiService] [processQuesPdfInChunks] Error in chunked PDF processing:",
      error,
    );
    throw error;
  }
};

export const processLargePdfInChunks = async (
  pdfBuffer,
  chunkPageCount = 50,
  forceContinuity = true,
) => {
  try {
    const mainPdfDoc = await PDFDocument.load(pdfBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    console.log(
      `[GeminiService] Splitting large PDF (${totalPages} pages) into chunks of ${chunkPageCount} pages...`,
    );
    const allQuestions = [];

    for (
      let startPage = 1;
      startPage <= totalPages;
      startPage += chunkPageCount
    ) {
      const endPage = Math.min(startPage + chunkPageCount - 1, totalPages);
      console.log(
        `[GeminiService] Processing chunk: pages ${startPage} to ${endPage}`,
      );

      // Create a sub-pdf for this chunk
      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from(
        { length: endPage - startPage + 1 },
        (_, index) => startPage - 1 + index,
      );
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();

      // Process this chunk with Gemini
      const chunkQuestions = await processEntirePdfWithGemini(
        Buffer.from(subPdfBytes),
      );

      if (chunkQuestions && Array.isArray(chunkQuestions)) {
        for (const q of chunkQuestions) {
          const absStart = startPage + q.start_page - 1;
          const absEnd = startPage + q.end_page - 1;

          allQuestions.push({
            question_text: cleanQuestionText(q.question_text),
            start_page: Math.min(absStart, totalPages),
            end_page: Math.min(absEnd, totalPages),
            answer_sheet_index: q.answer_sheet_index || 1,
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

    console.log(
      `[GeminiService] Batched processing complete. Found ${allQuestions.length} total questions.`,
    );
    return allQuestions;
  } catch (error) {
    console.error("[GeminiService] Error in processLargePdfInChunks:", error);
    throw error;
  }
};

export const getSubjectSyllabusText = (subject) => {
  try {
    const hierarchyPath = path.join(__dirname, "../syllabus_hierarchy.json");
    if (!fs.existsSync(hierarchyPath)) {
      console.warn("[GeminiService] syllabus_hierarchy.json not found!");
      return "";
    }

    const customData = JSON.parse(fs.readFileSync(hierarchyPath, "utf8"));
    let syllabusStr = "";

    let finalSubject = subject;
    if (
      !finalSubject.startsWith("GS-") &&
      !finalSubject.startsWith("OptionalSubject")
    ) {
      const cleanName = finalSubject.replace(/\s+/g, "");
      finalSubject = `OptionalSubject${cleanName.charAt(0).toUpperCase()}${cleanName.slice(1)}`;
    }

    if (finalSubject.startsWith("GS-")) {
      const sections = customData.gsModules?.[finalSubject] || [];
      syllabusStr += `--- COMPULSORY PAPER: ${finalSubject} ---\n`;
      sections.forEach((sectionItem) => {
        if (sectionItem.section) {
          syllabusStr += `Section: ${sectionItem.section}\n`;
        }
        if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
          sectionItem.topics.forEach((topicItem) => {
            if (topicItem.title) {
              syllabusStr += `  Topic: ${topicItem.title}\n`;
              if (topicItem.subtopics && Array.isArray(topicItem.subtopics)) {
                syllabusStr += `    Subtopics: ${topicItem.subtopics.join(", ")}\n`;
              }
            }
          });
        }
      });
    } else {
      const sections = customData.optionalSubjects?.[finalSubject] || [];
      syllabusStr += `--- OPTIONAL SUBJECT: ${finalSubject} ---\n`;
      sections.forEach((sectionItem) => {
        if (sectionItem.section) {
          syllabusStr += `Section: ${sectionItem.section}\n`;
        }
        if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
          sectionItem.topics.forEach((topicItem) => {
            if (topicItem.title) {
              syllabusStr += `  Topic: ${topicItem.title}\n`;
              if (topicItem.subtopics && Array.isArray(topicItem.subtopics)) {
                syllabusStr += `    Subtopics: ${topicItem.subtopics.join(", ")}\n`;
              }
            }
          });
        }
      });
    }

    return syllabusStr;
  } catch (e) {
    console.error("Failed to load subject syllabus:", e);
    return "";
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
          description:
            "List of exactly matched syllabus tags representing subject, paper, section, and topic.",
        },
      },
      required: ["tags"],
    };

    console.log(
      `[GeminiService] Assigning tags for question: "${questionText.substring(0, 40)}..."`,
    );
    const result = await withRetry(
      () =>
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
            temperature: 0.0,
          },
        }),
      3,
      3000,
    );

    const responseText = result.response.text();
    const jsonResult = JSON.parse(responseText);
    return jsonResult.tags || [];
  } catch (error) {
    console.error("[GeminiService] Error in tagQuestionWithGemini:", error);
    return [];
  }
};

// Classifies a list of distinct question texts against a freeform syllabus text pasted by the
// user (not the static syllabus_hierarchy.json). Batches questions per Gemini call to keep cost/
// latency reasonable for subjects with hundreds of questions. Returns a Map<question_text,
// {section, topic, paper}>; "paper" defaults to "Paper 1" whenever the syllabus text itself
// doesn't distinguish multiple papers.
export const classifyQuestionsForSubject = async (
  questionTexts,
  syllabusText,
  batchSize = 20,
) => {
  const resultMap = new Map();
  const totalBatches = Math.ceil(questionTexts.length / batchSize);
  console.log(
    `[GeminiService] [classifyQuestionsForSubject] Starting classification of ${questionTexts.length} question(s) in ${totalBatches} batch(es) of up to ${batchSize}...`,
  );

  const responseSchema = {
    type: SchemaType.ARRAY,
    items: {
      type: SchemaType.OBJECT,
      properties: {
        index: { type: SchemaType.INTEGER },
        section: { type: SchemaType.STRING },
        topic: { type: SchemaType.STRING },
        paper: { type: SchemaType.STRING },
      },
      required: ["index", "section", "topic", "paper"],
    },
  };

  for (let start = 0; start < questionTexts.length; start += batchSize) {
    const batchNum = Math.floor(start / batchSize) + 1;
    const batch = questionTexts.slice(start, start + batchSize);
    const batchPayload = batch.map((question_text, i) => ({
      index: i,
      question_text,
    }));
    console.log(
      `[GeminiService] [classifyQuestionsForSubject] Batch ${batchNum}/${totalBatches}: sending ${batch.length} question(s) to Gemini...`,
    );

    const prompt = `You are an expert syllabus classifier.
Below is a syllabus (pasted by the user as free-form text) for a single subject.
Your task is to classify each of the following questions against this syllabus.

--- SYLLABUS TEXT ---
${syllabusText}
----------------------

For each question below, identify:
1. 'section': The broad section/unit name from the syllabus this question best matches.
2. 'topic': The specific topic/sub-heading from the syllabus this question best matches.
3. 'paper': If the syllabus text distinguishes between multiple papers (e.g. "Paper 1", "Paper 2", "Paper I", "Paper II", or named papers), output the exact paper label as written in the syllabus text. If the syllabus text does NOT distinguish papers at all, output exactly "Paper 1" for every question.

RULES:
- 'section' and 'topic' MUST be taken from the syllabus text as closely as possible. DO NOT invent sections/topics that aren't represented in the syllabus text.
- If a question doesn't clearly map to any specific section/topic, use your best judgement to assign the closest matching section/topic. Never leave section or topic blank.
- Return EXACTLY one result object per input question, preserving its 'index' value, in any order.
- Return ONLY a JSON array.

Questions:
${JSON.stringify(batchPayload)}`;

    try {
      const result = await withRetry(
        () =>
          model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: responseSchema,
              temperature: 0.0,
            },
          }),
        4,
        5000,
      );

      const responseText = result.response.text();
      const jsonArray = JSON.parse(responseText);

      jsonArray.forEach((item) => {
        const questionText = batch[item.index];
        if (questionText === undefined) return;
        resultMap.set(questionText, {
          section: item.section || "Unassigned",
          topic: item.topic || "Unassigned",
          paper: item.paper || "Paper 1",
        });
      });
      console.log(
        `[GeminiService] [classifyQuestionsForSubject] Batch ${batchNum}/${totalBatches}: classified ${jsonArray.length} question(s) successfully.`,
      );
    } catch (error) {
      console.error(
        `[GeminiService] [classifyQuestionsForSubject] Batch ${batchNum}/${totalBatches} FAILED after retries (${batch.length} question(s) will fall back to 'Unassigned' / 'Paper 1'): ${error.message}`,
      );
      batch.forEach((questionText) => {
        if (!resultMap.has(questionText)) {
          resultMap.set(questionText, {
            section: "Unassigned",
            topic: "Unassigned",
            paper: "Paper 1",
          });
        }
      });
    }
  }

  console.log(
    `[GeminiService] [classifyQuestionsForSubject] Finished. Classified ${resultMap.size}/${questionTexts.length} question(s) total.`,
  );
  return resultMap;
};
