import { processEntirePdfWithGemini } from './geminiService.js';
import { UPSCQA } from '../models/UPSCQA.js';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

export const processPdf = async (fileBuffer, metadata) => {
  try {
    console.log(`[PdfProcessingService] Processing single-upload PDF...`);
    
    // 1. Get the Index from Gemini (Single Call)
    const indexArray = await processEntirePdfWithGemini(fileBuffer);
    
    if (!indexArray || indexArray.length === 0) {
      throw new Error("No questions detected in document.");
    }

    // 2. Load PDF to split
    const mainPdfDoc = await PDFDocument.load(fileBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    const outputDir = path.join(process.cwd(), 'public', 'extracted_pdfs');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const finalRecords = [];

    // 3. Loop and split
    for (let i = 0; i < indexArray.length; i++) {
      const item = indexArray[i];
      const startIdx = Math.max(0, item.start_page - 1);
      const endIdx = Math.min(totalPages - 1, item.end_page - 1);

      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from({ length: endIdx - startIdx + 1 }, (_, index) => startIdx + index);
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();
      const fileName = `Q${i + 1}_${Date.now()}.pdf`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, subPdfBytes);

      const file_url = `/extracted_pdfs/${fileName}`;

      finalRecords.push({
        question_text: item.question_text,
        subject: item.subject,
        topic: item.topic, 
        start_page: item.start_page,
        end_page: item.end_page,
        file_url: file_url,
        topper_name: metadata.topper_name,
        topper_year: metadata.topper_year,
        topper_rank: metadata.topper_rank,
        topper_marks: metadata.topper_marks
      });
    }

    console.log(`[PdfProcessingService] Prepared ${finalRecords.length} records. Applying deduplication rules...`);
    
    // Perform bulkWrite to upsert duplicate questions and push to file_urls array
    const bulkOps = finalRecords.map(record => ({
      updateOne: {
        filter: { question_text: record.question_text },
        update: { 
          $setOnInsert: {
            subject: record.subject,
            topic: record.topic,
            start_page: record.start_page,
            end_page: record.end_page
          },
          $push: { 
            file_urls: { 
              url: record.file_url, 
              topper_name: record.topper_name,
              topper_year: record.topper_year,
              topper_rank: record.topper_rank,
              topper_marks: record.topper_marks
            } 
          }
        },
        upsert: true
      }
    }));

    const bulkResult = await UPSCQA.bulkWrite(bulkOps);
    console.log(`[PdfProcessingService] Successfully merged to DB. Matched: ${bulkResult.matchedCount}, Inserted: ${bulkResult.upsertedCount}, Modified: ${bulkResult.modifiedCount}`);
    
    return finalRecords;

  } catch (error) {
    console.error("[PdfProcessingService] Error:", error);
    throw error;
  }
};