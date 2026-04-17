import express from 'express';
import { getAllQuestions, updateQuestion } from '../controllers/dataController.js';

const router = express.Router();

router.get('/questions', getAllQuestions);
router.put('/questions/:id', updateQuestion);

export default router;
