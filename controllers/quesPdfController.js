import { processQuesPdfWithGemini, processQuesPdfInChunks } from '../services/geminiService.js';
import { QuesPDF } from '../models/QuesPDF.js';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';

// Helper to save PDF locally on the server
const saveLocally = (buffer, fileName) => {
  const pdfDir = path.join(process.cwd(), 'public', 'extracted_pdfs');
  if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
  }
  const filePath = path.join(pdfDir, fileName);
  fs.writeFileSync(filePath, buffer);
  return `/public/extracted_pdfs/${fileName}`;
};

// Helper to sanitize text to be compatible with pdf-lib standard Helvetica (WinAnsi) font encoding
const cleanTextForWinAnsi = (text) => {
  if (!text) return '';
  // Normalize characters (e.g. smart quotes, em dashes) into standard equivalents
  let clean = text
    .replace(/[\u2018\u2019]/g, "'") // single smart quotes
    .replace(/[\u201C\u201D]/g, '"') // double smart quotes
    .replace(/[\u2013\u2014]/g, '-') // dashes
    .replace(/\u2212/g, '-') // minus sign
    .replace(/\u00A0/g, ' ') // non-breaking space
    .replace(/\u2022/g, '*'); // bullet point
  
  // Strip out any characters that are not in the standard printable ASCII range (32-126) + newline + tab + carriage return
  clean = clean.replace(/[^\x20-\x7E\n\r\t]/g, '');
  return clean.trim();
};

export const handleQuesPdfUpload = async (req, res) => {
  console.log(`[QuesPdfController] [handleQuesPdfUpload] New upload request initiated.`);
  try {
    if (!req.file) {
      console.warn(`[QuesPdfController] [handleQuesPdfUpload] Validation failed: No file found in request.`);
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    console.log(`[QuesPdfController] [handleQuesPdfUpload] File metadata: Name='${req.file.originalname}', Size=${req.file.size} bytes, MimeType='${req.file.mimetype}'`);

    if (req.file.mimetype !== 'application/pdf') {
      console.warn(`[QuesPdfController] [handleQuesPdfUpload] Validation failed: MimeType is not application/pdf.`);
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    const startPage = req.body.startPage ? parseInt(req.body.startPage) : 1;
    const endPage = req.body.endPage ? parseInt(req.body.endPage) : null;
    const chunkSize = req.body.chunkSize ? parseInt(req.body.chunkSize) : 50;
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Step 1: Initiating Gemini page-by-page chunked scan (Range: ${startPage} to ${endPage || 'End'}, Chunk Size: ${chunkSize} pages)...`);
    const questions = await processQuesPdfInChunks(req.file.buffer, chunkSize, startPage, endPage);
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Gemini chunked scan completed. Extracted ${questions ? questions.length : 0} questions.`);

    console.log(`[QuesPdfController] [handleQuesPdfUpload] Step 2: Loading original PDF into pdf-lib...`);
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pages = pdfDoc.getPages();
    const totalPdfPages = pages.length;
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Original PDF loaded successfully. Total pages: ${totalPdfPages}`);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    console.log(`[QuesPdfController] [handleQuesPdfUpload] Beginning page overlays processing...`);
    for (let i = 0; i < questions.length; i++) {
      const item = questions[i];
      item.question_text = cleanTextForWinAnsi(item.question_text);
      const pageIndex = item.page_number - 1;
      console.log(`[QuesPdfController] [handleQuesPdfUpload] Processing question ${i + 1}/${questions.length}: Page ${item.page_number} (Index: ${pageIndex})`);
      
      if (pageIndex >= 0 && pageIndex < totalPdfPages) {
        const page = pages[pageIndex];
        const { width, height } = page.getSize();
        console.log(`[QuesPdfController] [handleQuesPdfUpload] Page ${item.page_number} dimensions: Width=${width.toFixed(2)}, Height=${height.toFixed(2)}`);

        const boxHeight = height * 0.2; // 20% height from top
        const boxY = height - boxHeight;

        // Wrap and scale question text
        const padding = 20;
        const maxTextWidth = width - (padding * 2);
        let fontSize = 11;
        const words = item.question_text.replace(/\n/g, ' ').split(' ');

        const wrapText = (words, size, maxW) => {
          const lines = [];
          let currentLine = '';
          for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const w = fontBold.widthOfTextAtSize(testLine, size);
            if (w > maxW) {
              lines.push(currentLine);
              currentLine = word;
            } else {
              currentLine = testLine;
            }
          }
          if (currentLine) lines.push(currentLine);
          return lines;
        };

        let lines = wrapText(words, fontSize, maxTextWidth);
        let totalTextHeight = lines.length * (fontSize * 1.4);
        const maxTextHeight = boxHeight - 40;

        console.log(`[QuesPdfController] [handleQuesPdfUpload] Text wrapping check: Initial Font Size=${fontSize}, Line count=${lines.length}, Total height=${totalTextHeight.toFixed(2)}, Max allowed text height=${maxTextHeight.toFixed(2)}`);

        // Shrink font size if it overflows
        while (totalTextHeight > maxTextHeight && fontSize > 7) {
          const prevFontSize = fontSize;
          fontSize -= 0.5;
          lines = wrapText(words, fontSize, maxTextWidth);
          totalTextHeight = lines.length * (fontSize * 1.4);
          console.log(`[QuesPdfController] [handleQuesPdfUpload] Text overflow detected. Shrinking font from ${prevFontSize} to ${fontSize}. New line count=${lines.length}, New total height=${totalTextHeight.toFixed(2)}`);
        }

        // Draw the text starting at 7% margin from top (93% height from bottom)
        let currentY = height * 0.93;
        const lineHeight = fontSize * 1.4;
        console.log(`[QuesPdfController] [handleQuesPdfUpload] Starting text drawing on Page ${item.page_number} at Y=${currentY.toFixed(2)} with Line Height=${lineHeight.toFixed(2)}`);
        
        for (let l = 0; l < lines.length; l++) {
          const line = lines[l];
          const textWidth = fontBold.widthOfTextAtSize(line, fontSize);
          
          // Draw yellow highlight behind the text (exactly text size + 1)
          page.drawRectangle({
            x: padding - 0.5,
            y: currentY - 0.5,
            width: textWidth + 1,
            height: fontSize + 1,
            color: rgb(1.0, 1.0, 0.35), // Clean highlighter yellow
            opacity: 0.95
          });

          page.drawText(line, {
            x: padding,
            y: currentY,
            size: fontSize,
            font: fontBold,
            color: rgb(0.06, 0.09, 0.16)
          });
          currentY -= lineHeight;
        }
        console.log(`[QuesPdfController] [handleQuesPdfUpload] Overlay rendering complete for Page ${item.page_number}.`);
      } else {
        console.warn(`[QuesPdfController] [handleQuesPdfUpload] Skip page overlay: Target page_number ${item.page_number} is out of bounds (Total pages in PDF: ${totalPdfPages}).`);
      }
    }

    // Save modified PDF
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Saving modified PDF buffer in memory...`);
    const modifiedPdfBytes = await pdfDoc.save();
    console.log(`[QuesPdfController] [handleQuesPdfUpload] PDF successfully modified in memory. Size: ${modifiedPdfBytes.length} bytes.`);

    // 3. Save modified PDF locally
    const fileNameObj = `QuesPDF_${Date.now()}.pdf`;
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Step 3: Saving modified PDF file: '${fileNameObj}' locally on server...`);
    const relativeUrl = saveLocally(modifiedPdfBytes, fileNameObj);
    const processedFileUrl = `${req.protocol}://${req.get('host')}${relativeUrl}`;
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Local write successful. URL path: ${processedFileUrl}`);

    // 4. Save to Database
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Step 4: Creating MongoDB entry...`);
    const record = await QuesPDF.create({
      originalName: req.file.originalname,
      questions: questions,
      pdfUrl: processedFileUrl
    });
    console.log(`[QuesPdfController] [handleQuesPdfUpload] Database record created successfully. ID: ${record._id}`);

    res.status(200).json({
      message: 'PDF successfully processed, questions extracted, and overlaid.',
      data: record
    });

  } catch (error) {
    console.error("[QuesPdfController] [handleQuesPdfUpload] Execution error occurred:", error);
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
      console.error("[QuesPdfController] [handleQuesPdfUpload] Specific restriction: Gemini API restricted in location.");
      return res.status(403).json({ 
        error: 'Google Gemini API is restricted in the server\'s current location.' 
      });
    }
    res.status(500).json({ error: 'Failed to process QuesPDF.', details: error.message });
  }
};

export const getQuesPdfHistory = async (req, res) => {
  try {
    const history = await QuesPDF.find({}).sort({ createdAt: -1 });
    res.status(200).json(history);
  } catch (error) {
    console.error("[QuesPdfController] Error fetching history:", error);
    res.status(500).json({ error: 'Failed to fetch QuesPDF history.' });
  }
};

export const updateQuesPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const { questions } = req.body;

    if (!questions || !Array.isArray(questions)) {
      return res.status(400).json({ error: 'Questions array is required.' });
    }

    const updated = await QuesPDF.findByIdAndUpdate(
      id,
      { questions },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: 'QuesPDF record not found.' });
    }

    res.status(200).json({
      message: 'QuesPDF record updated successfully.',
      data: updated
    });
  } catch (error) {
    console.error("[QuesPdfController] Error updating record:", error);
    res.status(500).json({ error: 'Failed to update QuesPDF record.' });
  }
};

export const deleteQuesPdf = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await QuesPDF.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: 'QuesPDF record not found.' });
    }

    res.status(200).json({ message: 'QuesPDF record deleted successfully.' });
  } catch (error) {
    console.error("[QuesPdfController] Error deleting record:", error);
    res.status(500).json({ error: 'Failed to delete QuesPDF record.' });
  }
};
