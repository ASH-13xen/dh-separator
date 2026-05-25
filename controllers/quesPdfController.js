import { processQuesPdfWithGemini } from '../services/geminiService.js';
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

export const handleQuesPdfUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    console.log(`[QuesPdfController] Received file: ${req.file.originalname}, Size: ${req.file.size} bytes`);
    console.log(`[QuesPdfController] Initiating Gemini page-by-page scan...`);

    // 1. Process PDF with Gemini to get questions page-by-page
    const questions = await processQuesPdfWithGemini(req.file.buffer);
    console.log(`[QuesPdfController] Gemini scan complete. Found ${questions.length} questions.`);

    // 2. Load PDF into pdf-lib to overlay questions on respective pages
    console.log(`[QuesPdfController] Editing PDF with pdf-lib...`);
    const pdfDoc = await PDFDocument.load(req.file.buffer);
    const pages = pdfDoc.getPages();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Overlay questions
    for (const item of questions) {
      const pageIndex = item.page_number - 1;
      if (pageIndex >= 0 && pageIndex < pages.length) {
        const page = pages[pageIndex];
        const { width, height } = page.getSize();

        const boxHeight = height * 0.2; // 20% height from top
        const boxY = height - boxHeight;

        // Draw no background (transparent bg), border, or extra ornaments - just the question text.

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

        // Shrink font size if it overflows
        while (totalTextHeight > maxTextHeight && fontSize > 7) {
          fontSize -= 0.5;
          lines = wrapText(words, fontSize, maxTextWidth);
          totalTextHeight = lines.length * (fontSize * 1.4);
        }

        // Draw the text starting at 7% margin from top (93% height from bottom)
        let currentY = height * 0.93;
        const lineHeight = fontSize * 1.4;
        for (const line of lines) {
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
      }
    }

    // Save modified PDF
    const modifiedPdfBytes = await pdfDoc.save();
    console.log(`[QuesPdfController] PDF successfully modified.`);

    // 3. Save modified PDF locally
    const fileNameObj = `QuesPDF_${Date.now()}.pdf`;
    console.log(`[QuesPdfController] Saving modified PDF locally...`);
    const relativeUrl = saveLocally(modifiedPdfBytes, fileNameObj);
    const processedFileUrl = `${req.protocol}://${req.get('host')}${relativeUrl}`;
    console.log(`[QuesPdfController] Local save successful: ${processedFileUrl}`);

    // 4. Save to Database
    const record = await QuesPDF.create({
      originalName: req.file.originalname,
      questions: questions,
      pdfUrl: processedFileUrl
    });

    res.status(200).json({
      message: 'PDF successfully processed, questions extracted, and overlaid.',
      data: record
    });

  } catch (error) {
    console.error("[QuesPdfController] Error:", error);
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
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
