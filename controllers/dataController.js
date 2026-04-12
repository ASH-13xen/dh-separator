import { UPSCQA } from '../models/UPSCQA.js';

export const getAllQuestions = async (req, res) => {
  try {
    const questions = await UPSCQA.find({}).sort({ createdAt: -1 });
    res.status(200).json(questions);
  } catch (error) {
    console.error("[DataController] Error fetching questions:", error);
    res.status(500).json({ error: 'Failed to retrieve questions from the database.' });
  }
};
