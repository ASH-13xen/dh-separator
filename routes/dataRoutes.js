import express from 'express';
import { getAllQuestions, updateQuestion, getValidTags, getHierarchy } from '../controllers/dataController.js';

const router = express.Router();

router.get('/questions', getAllQuestions);
router.put('/questions/:id', updateQuestion);
router.get('/tags', getValidTags);
router.get('/hierarchy', getHierarchy);

export default router;
