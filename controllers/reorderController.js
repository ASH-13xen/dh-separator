import { processLargePdfInChunks } from '../services/geminiService.js';
import { ReorderPDF } from '../models/ReorderPDF.js';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Local storage directory helper
const saveLocally = (buffer, fileName) => {
  const pdfDir = path.join(process.cwd(), 'public', 'extracted_pdfs');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const filePath = path.join(pdfDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return `/public/extracted_pdfs/${fileName}`;
};

// Local path resolver from URL
const getLocalPath = (fileUrl) => {
  try {
    const parsed = new URL(fileUrl, 'http://localhost');
    const decodedPathname = decodeURIComponent(parsed.pathname);
    // Remove leading slash if path.join expects relative components, 
    // but on Windows path.join with absolute-looking path handles it safely.
    return path.join(process.cwd(), decodedPathname);
  } catch (err) {
    return path.join(process.cwd(), fileUrl);
  }
};

export const processReorderPdf = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    console.log(`[ReorderController] Processing PDF for split & reorder (Local Only): ${req.file.originalname}`);
    const fileBuffer = req.file.buffer;

    // 1. Get question indexing from Gemini (with batch chunked service, forceContinuity = false)
    const indexArray = await processLargePdfInChunks(fileBuffer, 50, false);
    if (!indexArray || indexArray.length === 0) {
      return res.status(400).json({ error: 'No questions detected in this document.' });
    }

    // 2. Load PDF with pdf-lib to get total pages and split
    const mainPdfDoc = await PDFDocument.load(fileBuffer);
    const totalPages = mainPdfDoc.getPageCount();

    // 3. Build raw chunks list, keeping unmapped page gaps marked as separate chunks
    const rawChunks = [];
    let currentStart = 1;

    // Sort questions by start_page
    const sortedQuestions = [...indexArray].sort((a, b) => a.start_page - b.start_page);

    for (const q of sortedQuestions) {
      // If there is an unmapped gap before this question, keep it marked and separate
      if (q.start_page > currentStart) {
        rawChunks.push({
          question_text: `[Unmapped Pages ${currentStart} - ${q.start_page - 1}]`,
          start_page: currentStart,
          end_page: q.start_page - 1
        });
      }

      rawChunks.push({
        question_text: q.question_text,
        start_page: q.start_page,
        end_page: q.end_page
      });

      currentStart = q.end_page + 1;
    }

    // If there are leftover pages at the end
    if (currentStart <= totalPages) {
      rawChunks.push({
        question_text: `[Unmapped Pages ${currentStart} - ${totalPages}]`,
        start_page: currentStart,
        end_page: totalPages
      });
    }

    // 4. Split PDF into chunks and save them locally
    console.log(`[ReorderController] Splitting into ${rawChunks.length} local chunks...`);
    const finalChunks = [];

    for (let i = 0; i < rawChunks.length; i++) {
      const chunk = rawChunks[i];
      const startIdx = Math.max(0, chunk.start_page - 1);
      const endIdx = Math.min(totalPages - 1, chunk.end_page - 1);

      if (startIdx > endIdx) continue;

      const subPdf = await PDFDocument.create();
      const pagesToCopy = Array.from({ length: endIdx - startIdx + 1 }, (_, index) => startIdx + index);
      const copiedPages = await subPdf.copyPages(mainPdfDoc, pagesToCopy);
      copiedPages.forEach((page) => subPdf.addPage(page));

      const subPdfBytes = await subPdf.save();
      const fileName = `Reorder_${Date.now()}_chunk_${i + 1}.pdf`;

      // Save locally to the server public static directory
      const relativePath = saveLocally(Buffer.from(subPdfBytes), fileName);
      const fileUrl = `${req.protocol}://${req.get('host')}${relativePath}`;

      finalChunks.push({
        question_text: chunk.question_text,
        start_page: chunk.start_page,
        end_page: chunk.end_page,
        file_url: fileUrl
      });
    }

    // 5. Save record in database
    const record = await ReorderPDF.create({
      originalName: req.file.originalname,
      chunks: finalChunks
    });

    console.log(`[ReorderController] PDF processed locally. Created record: ${record._id}`);
    res.status(200).json({
      message: 'PDF successfully split, stored locally, and indexed.',
      data: record
    });

  } catch (error) {
    console.error("[ReorderController] Error in processReorderPdf:", error);
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
      return res.status(403).json({ 
        error: 'Google Gemini API is restricted in the server\'s current location.' 
      });
    }
    res.status(500).json({ error: 'Failed to process PDF.', details: error.message });
  }
};

export const compileReorderPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await ReorderPDF.findById(id);

    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    const chunks = record.chunks;
    if (!chunks || chunks.length === 0) {
      return res.status(400).json({ error: 'No chunks available in sequence to compile.' });
    }

    console.log(`[ReorderController] Compiling ${chunks.length} chunks locally for record: ${id}`);

    // Read each chunk directly from the local disk
    const pdfBuffers = [];
    for (const chunk of chunks) {
      try {
        const localPath = getLocalPath(chunk.file_url);
        if (!fs.existsSync(localPath)) {
          throw new Error(`File not found: ${localPath}`);
        }
        const buffer = fs.readFileSync(localPath);
        pdfBuffers.push(buffer);
      } catch (readError) {
        console.error(`[ReorderController] Failed to read chunk from URL: ${chunk.file_url}`, readError);
        return res.status(500).json({ error: `Failed to read segment file from local storage: ${chunk.question_text.substring(0, 30)}...` });
      }
    }

    // Merge buffers using pdf-lib
    const mergedPdf = await PDFDocument.create();
    for (let i = 0; i < pdfBuffers.length; i++) {
      const buffer = pdfBuffers[i];
      const srcDoc = await PDFDocument.load(buffer);
      const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const mergedPdfBytes = await mergedPdf.save();
    const fileName = `Compiled_Reorder_${id}_${Date.now()}.pdf`;

    // Save locally
    const relativeCompiledPath = saveLocally(Buffer.from(mergedPdfBytes), fileName);
    const compiledUrl = `${req.protocol}://${req.get('host')}${relativeCompiledPath}`;

    record.pdfUrl = compiledUrl;
    await record.save();

    console.log(`[ReorderController] Successfully compiled PDF locally: ${record.pdfUrl}`);
    res.status(200).json({
      message: 'PDF compiled and merged successfully.',
      data: record
    });

  } catch (error) {
    console.error("[ReorderController] Error in compileReorderPdf:", error);
    res.status(500).json({ error: 'Failed to compile reordered PDF.', details: error.message });
  }
};

export const getReorderHistory = async (req, res) => {
  try {
    const history = await ReorderPDF.find({}).sort({ createdAt: -1 });
    res.status(200).json(history);
  } catch (error) {
    console.error("[ReorderController] Error fetching reorder history:", error);
    res.status(500).json({ error: 'Failed to fetch history.' });
  }
};

export const getReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await ReorderPDF.findById(id);
    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    res.status(200).json(record);
  } catch (error) {
    console.error("[ReorderController] Error fetching record:", error);
    res.status(500).json({ error: 'Failed to fetch record.' });
  }
};

export const updateReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const { chunks } = req.body;

    if (!chunks || !Array.isArray(chunks)) {
      return res.status(400).json({ error: 'Chunks array is required.' });
    }

    const updated = await ReorderPDF.findByIdAndUpdate(
      id,
      { chunks, pdfUrl: null }, // Reset pdfUrl because the sequence has changed and is now dirty
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    res.status(200).json({
      message: 'Record updated successfully.',
      data: updated
    });
  } catch (error) {
    console.error("[ReorderController] Error updating record:", error);
    res.status(500).json({ error: 'Failed to update record.' });
  }
};

export const deleteReorderRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await ReorderPDF.findById(id);

    if (!record) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    // Delete local chunk files to free up disk space
    if (record.chunks && Array.isArray(record.chunks)) {
      for (const chunk of record.chunks) {
        try {
          const filePath = getLocalPath(chunk.file_url);
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {
          console.warn("[ReorderController] Failed to delete local chunk file during clean up:", e.message);
        }
      }
    }

    // Delete local compiled PDF file if exists
    if (record.pdfUrl) {
      try {
        const compiledPath = getLocalPath(record.pdfUrl);
        if (fs.existsSync(compiledPath)) {
          fs.unlinkSync(compiledPath);
        }
      } catch (e) {
        console.warn("[ReorderController] Failed to delete local compiled PDF during clean up:", e.message);
      }
    }

    await ReorderPDF.findByIdAndDelete(id);
    res.status(200).json({ message: 'Record and local physical files deleted successfully.' });
  } catch (error) {
    console.error("[ReorderController] Error deleting record:", error);
    res.status(500).json({ error: 'Failed to delete record.' });
  }
};
