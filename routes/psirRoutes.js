import express from 'express';
import { previewPsirData, generatePsirPdf, getPsirBookStatus, downloadPsirBook, cleanupPsirStorage, previewTopperFile } from '../controllers/psirController.js';

const router = express.Router();

// GET /api/psir/preview
router.get('/preview', previewPsirData);

// POST /api/psir/generate
router.post('/generate', generatePsirPdf);

// GET /api/psir/status/:id
router.get('/status/:id', getPsirBookStatus);

// GET /api/psir/download/:id
router.get('/download/:id', downloadPsirBook);

// POST /api/psir/cleanup-storage
router.post('/cleanup-storage', cleanupPsirStorage);

// GET /api/psir/preview-file
router.get('/preview-file', previewTopperFile);

export default router;
