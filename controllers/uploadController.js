import { processPdf } from '../services/pdfProcessingService.js';
import { UPSCQA } from '../models/UPSCQA.js';
import streamifier from 'streamifier';
import { v2 as cloudinary } from 'cloudinary';

const uploadToCloudinary = (buffer, fileName) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'upsc_answers', public_id: fileName },
      (error, result) => {
        if (result) resolve(result.secure_url);
        else reject(error);
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
};

export const handlePdfUpload = async (req, res) => {
  console.log('[UploadController] [handlePdfUpload] Request received.');
  try {
    if (!req.file) {
      console.warn('[UploadController] [handlePdfUpload] Validation failed: no file uploaded.');
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    if (req.file.mimetype !== 'application/pdf') {
      console.warn(`[UploadController] [handlePdfUpload] Validation failed: invalid mimetype '${req.file.mimetype}'.`);
      return res.status(400).json({ error: 'Please upload a valid PDF file.' });
    }

    const subject = req.body.subject ? String(req.body.subject).trim() : '';
    if (!subject) {
      console.warn('[UploadController] [handlePdfUpload] Validation failed: missing subject.');
      return res.status(400).json({ error: 'Subject is required.' });
    }
    console.log(`[UploadController] [handlePdfUpload] Subject: '${subject}'.`);

    let parsedMetadataList = [{ topperName: 'Unknown Topper' }];
    if (req.body.metadataList) {
      try {
        parsedMetadataList = JSON.parse(req.body.metadataList);
      } catch (e) {
        console.warn("[UploadController] Failed to parse metadataList. Using fallback.");
      }
    }

    console.log(`[UploadController] Received file: ${req.file.originalname}, Sheets specified: ${parsedMetadataList.length}, Size: ${req.file.size} bytes`);
    console.log(`[UploadController] Initiating processPdf...`);
    
    // Pass the memory buffer and metadata array to the service layer
    const results = await processPdf(req.file.buffer, parsedMetadataList, subject);

    console.log(`[UploadController] processPdf completed successfully. Total records generated: ${results.length}`);

    res.status(200).json({
      message: 'PDF successfully processed and analyzed.',
      totalRecords: results.length,
      data: results
    });

  } catch (error) {
    console.error("[UploadController] Upload controller error:", error);
    if (error.message === 'LOCATION_NOT_SUPPORTED' || (error.message && error.message.includes('User location is not supported'))) {
      return res.status(403).json({ 
        error: 'Google Gemini API is restricted in the server\'s current location. Please deploy the server to a supported region (e.g. US Oregon) or use a proxy.' 
      });
    }
    res.status(500).json({ error: 'Failed to process the uploaded PDF document.', details: error.message });
  }
};

export const handleManualUpload = async (req, res) => {
  console.log('[UploadController] [handleManualUpload] Request received.');
  try {
    if (!req.file) {
      console.warn('[UploadController] [handleManualUpload] Validation failed: no file uploaded.');
      return res.status(400).json({ error: 'No PDF file uploaded.' });
    }

    const { question_text, topper_name, topper_year, topper_rank, topper_marks, subject } = req.body;
    if (!question_text) {
      console.warn('[UploadController] [handleManualUpload] Validation failed: missing question text.');
      return res.status(400).json({ error: 'Question text is required.' });
    }
    if (!subject || !String(subject).trim()) {
      console.warn('[UploadController] [handleManualUpload] Validation failed: missing subject.');
      return res.status(400).json({ error: 'Subject is required.' });
    }
    console.log(`[UploadController] [handleManualUpload] Subject: '${subject}'. Question: "${String(question_text).slice(0, 60)}..."`);

    console.log('[UploadController] [handleManualUpload] Uploading answer sheet to Cloudinary...');
    const fileNameObj = `Manual_${Date.now()}`;
    const file_url = await uploadToCloudinary(req.file.buffer, fileNameObj);
    console.log(`[UploadController] [handleManualUpload] Cloudinary upload complete: ${file_url}`);

    console.log('[UploadController] [handleManualUpload] Upserting question record in MongoDB...');
    const result = await UPSCQA.findOneAndUpdate(
      { question_text },
      {
        $setOnInsert: {
          subject: String(subject).trim(),
          start_page: 1,
          end_page: 1
        },
        $push: {
          file_urls: {
            url: file_url,
            topper_name: topper_name || 'Unknown Topper',
            topper_year: topper_year || '',
            topper_rank: topper_rank || '',
            topper_marks: topper_marks || ''
          }
        }
      },
      { upsert: true, new: true }
    );
    console.log(`[UploadController] [handleManualUpload] Saved successfully. Record ID: ${result._id}`);

    res.status(200).json({
      message: 'Manual question uploaded successfully.',
      data: result
    });
  } catch (error) {
    console.error("[UploadController] Manual upload error:", error);
    res.status(500).json({ error: 'Failed to upload manual question.', details: error.message });
  }
};

export const updateTopperDetails = async (req, res) => {
  console.log('[UploadController] [updateTopperDetails] Request received.');
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      console.warn('[UploadController] [updateTopperDetails] Validation failed: missing updates array.');
      return res.status(400).json({ error: 'Updates array is required.' });
    }
    console.log(`[UploadController] [updateTopperDetails] Applying ${updates.length} topper detail update(s)...`);

    const bulkOps = updates.map(update => ({
      updateMany: {
        filter: { 'file_urls.url': update.file_url },
        update: {
          $set: {
            'file_urls.$[elem].topper_name': update.topper_name || 'Unknown Topper',
            'file_urls.$[elem].topper_year': update.topper_year || '',
            'file_urls.$[elem].topper_rank': update.topper_rank || '',
            'file_urls.$[elem].topper_marks': update.topper_marks || ''
          }
        },
        arrayFilters: [{ 'elem.url': update.file_url }]
      }
    }));

    if (bulkOps.length > 0) {
      await UPSCQA.bulkWrite(bulkOps);
    }
    console.log('[UploadController] [updateTopperDetails] Updates applied successfully.');

    res.status(200).json({ message: 'Topper details updated successfully.' });
  } catch (error) {
    console.error("[UploadController] Error updating topper details:", error);
    res.status(500).json({ error: 'Failed to update topper details.' });
  }
};