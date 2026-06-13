import express from 'express';
import { previewPsirData, generatePsirPdf } from '../controllers/psirController.js';

const router = express.Router();

// GET /api/psir/preview
router.get('/preview', previewPsirData);

// POST /api/psir/generate
router.post('/generate', generatePsirPdf);

export default router;
