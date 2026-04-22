import express from 'express';
import { getAllQuestions, updateQuestion, getValidTags } from '../controllers/dataController.js';

const router = express.Router();

router.get('/questions', getAllQuestions);
router.put('/questions/:id', updateQuestion);
router.get('/tags', getValidTags);

export default router;
