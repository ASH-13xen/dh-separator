import { processPdf } from '../services/pdfProcessingService.js';

export const handlePdfUpload = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    const topper_name = req.body.topper_name || 'Unknown Topper';
    const topper_year = req.body.topper_year || '';
    const topper_rank = req.body.topper_rank || '';
    const topper_marks = req.body.topper_marks || '';

    console.log(`[UploadController] Received file: ${req.file.originalname}, Topper: ${topper_name}, Size: ${req.file.size} bytes`);
    console.log(`[UploadController] Initiating processPdf...`);
    
    // Pass the memory buffer and metadata to the service layer
    const results = await processPdf(req.file.buffer, {
        topper_name, topper_year, topper_rank, topper_marks
    });

    console.log(`[UploadController] processPdf completed successfully. Total records generated: ${results.length}`);

    res.status(200).json({
      message: 'PDF successfully processed and analyzed.',
      totalRecords: results.length,
      data: results
    });

  } catch (error) {
    console.error("[UploadController] Upload controller error:", error);
    res.status(500).json({ error: 'Failed to process the uploaded PDF document.', details: error.message });
  }
};
