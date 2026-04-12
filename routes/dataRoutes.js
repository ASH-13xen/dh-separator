import express from 'express';
import { getAllQuestions } from '../controllers/dataController.js';

const router = express.Router();

router.get('/questions', getAllQuestions);

export default router;
