import express from 'express';
import multer from 'multer';
import { handlePdfUpload, handleManualUpload } from '../controllers/uploadController.js';

const router = express.Router();

// Setup Multer to store uploaded file buffer in memory
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  // limits: { fileSize: 50 * 1024 * 1024 } // Optional: enforce a 50MB file size limit
});

// POST /api/upload route
router.post('/upload', upload.single('pdf'), handlePdfUpload);

// POST /api/upload/manual route
router.post('/upload/manual', upload.single('pdf'), handleManualUpload);

export default router;
