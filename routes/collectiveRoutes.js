import express from 'express';
import { generateCollectivePdf, previewSubjectData } from '../controllers/collectiveController.js';

const router = express.Router();

// GET /api/collective/preview?subject=...
router.get('/preview', previewSubjectData);

// POST /api/collective/generate
router.post('/generate', generateCollectivePdf);

export default router;
