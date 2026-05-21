import { UPSCQA } from '../models/UPSCQA.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const getAllQuestions = async (req, res) => {
  try {
    const questions = await UPSCQA.find({}).sort({ createdAt: -1 });
    res.status(200).json(questions);
  } catch (error) {
    console.error("[DataController] Error fetching questions:", error);
    res.status(500).json({ error: 'Failed to retrieve questions from the database.' });
  }
};

export const updateQuestion = async (req, res) => {
  try {
    const { id } = req.params;
    const { tags, file_urls } = req.body;

    const updatedQuestion = await UPSCQA.findByIdAndUpdate(
      id,
      { tags, ...(file_urls && { file_urls }) },
      { new: true, runValidators: true }
    );

    if (!updatedQuestion) {
      return res.status(404).json({ error: 'Question not found' });
    }

    res.status(200).json(updatedQuestion);
  } catch (error) {
    console.error("[DataController] Error updating question:", error);
    res.status(500).json({ error: 'Failed to update question in the database.' });
  }
};

export const getValidTags = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.js'));
    
    const validTags = new Set();
    
    for (const file of files) {
      if (file.startsWith('GS-')) {
         validTags.add(file.replace('.js', ''));
      }
      
      const filePath = path.join(constantsDir, file);
      const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
      const module = await import(modulePath);
      
      const exportKeys = Object.keys(module);
      for (const key of exportKeys) {
        const data = module[key];
        if (Array.isArray(data)) {
           if (file.startsWith('OptionalSubject')) {
              validTags.add(file.replace('.js', ''));
           }
           
           data.forEach(sectionItem => {
             if (sectionItem.section) validTags.add(sectionItem.section);
             if (sectionItem.topics && Array.isArray(sectionItem.topics)) {
               sectionItem.topics.forEach(topicItem => {
                 if (topicItem.title) validTags.add(topicItem.title);
               });
             }
           });
        }
      }
    }

    // Merge custom hierarchy tags
    const customPath = path.join(constantsDir, 'customHierarchy.json');
    if (fs.existsSync(customPath)) {
      try {
        const customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
        if (customData.gsModules) {
          Object.entries(customData.gsModules).forEach(([mod, sections]) => {
            validTags.add(mod);
            sections.forEach(secItem => {
              if (secItem.section) validTags.add(secItem.section);
              if (secItem.topics) {
                secItem.topics.forEach(topicItem => {
                  if (topicItem.title) validTags.add(topicItem.title);
                });
              }
            });
          });
        }
        if (customData.optionalSubjects) {
          Object.entries(customData.optionalSubjects).forEach(([sub, sections]) => {
            validTags.add(sub);
            sections.forEach(secItem => {
              if (secItem.section) validTags.add(secItem.section);
              if (secItem.topics) {
                secItem.topics.forEach(topicItem => {
                  if (topicItem.title) validTags.add(topicItem.title);
                });
              }
            });
          });
        }
      } catch (err) {
        console.error("Error reading custom tags for getValidTags:", err);
      }
    }
    
    res.status(200).json(Array.from(validTags).sort());
  } catch (error) {
    console.error("[DataController] Error fetching valid tags:", error);
    res.status(500).json({ error: 'Failed to retrieve tags from the server.' });
  }
};

export const getHierarchy = async (req, res) => {
  try {
    const constantsDir = path.join(__dirname, '../constants');
    const files = fs.readdirSync(constantsDir).filter(f => f.endsWith('.js'));
    
    const hierarchyData = {
      gsModules: {},
      optionalSubjects: {}
    };
    
    for (const file of files) {
      const filePath = path.join(constantsDir, file);
      const modulePath = 'file:///' + filePath.replace(/\\/g, '/');
      const module = await import(modulePath);
      
      let structure = [];
      const exportKeys = Object.keys(module);
      for (const key of exportKeys) {
        const data = module[key];
        if (Array.isArray(data)) {
           structure = data;
           break;
        }
      }
      
      if (file.startsWith('GS-')) {
         const moduleName = file.replace('.js', '');
         hierarchyData.gsModules[moduleName] = structure;
      } else if (file.startsWith('OptionalSubject')) {
         const moduleName = file.replace('.js', '');
         hierarchyData.optionalSubjects[moduleName] = structure;
      }
    }

    // Merge custom hierarchy if exists
    const customPath = path.join(constantsDir, 'customHierarchy.json');
    if (fs.existsSync(customPath)) {
      try {
        const customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
        if (customData.gsModules) {
          Object.entries(customData.gsModules).forEach(([mod, sections]) => {
            if (!hierarchyData.gsModules[mod]) {
              hierarchyData.gsModules[mod] = [];
            }
            sections.forEach(secObj => {
              const existingSec = hierarchyData.gsModules[mod].find(s => s.section === secObj.section);
              if (!existingSec) {
                hierarchyData.gsModules[mod].push({
                  section: secObj.section,
                  topics: secObj.topics ? [...secObj.topics] : []
                });
              } else {
                if (secObj.topics) {
                  secObj.topics.forEach(topObj => {
                    const existingTop = existingSec.topics.find(t => t.title === topObj.title);
                    if (!existingTop) {
                      existingSec.topics.push({ title: topObj.title });
                    }
                  });
                }
              }
            });
          });
        }
        
        if (customData.optionalSubjects) {
          Object.entries(customData.optionalSubjects).forEach(([sub, sections]) => {
            if (!hierarchyData.optionalSubjects[sub]) {
              hierarchyData.optionalSubjects[sub] = [];
            }
            sections.forEach(secObj => {
              const existingSec = hierarchyData.optionalSubjects[sub].find(s => s.section === secObj.section);
              if (!existingSec) {
                hierarchyData.optionalSubjects[sub].push({
                  section: secObj.section,
                  topics: secObj.topics ? [...secObj.topics] : []
                });
              } else {
                if (secObj.topics) {
                  secObj.topics.forEach(topObj => {
                    const existingTop = existingSec.topics.find(t => t.title === topObj.title);
                    if (!existingTop) {
                      existingSec.topics.push({ title: topObj.title });
                    }
                  });
                }
              }
            });
          });
        }
      } catch (err) {
        console.error("Error reading custom hierarchy:", err);
      }
    }
    
    res.status(200).json(hierarchyData);
  } catch (error) {
    console.error("[DataController] Error fetching hierarchy:", error);
    res.status(500).json({ error: 'Failed to retrieve hierarchy.' });
  }
};

export const addCustomTag = async (req, res) => {
  try {
    const { type, name, parentModule, parentSection } = req.body;
    if (!type || !name) {
      return res.status(400).json({ error: "Type and name are required." });
    }
    
    const constantsDir = path.join(__dirname, '../constants');
    const customPath = path.join(constantsDir, 'customHierarchy.json');
    
    let customData = {
      gsModules: {},
      optionalSubjects: {}
    };
    
    if (fs.existsSync(customPath)) {
      try {
        customData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      } catch (err) {
        console.error("Error parsing existing customHierarchy.json, creating new:", err);
      }
    }
    
    if (type === 'gsModule') {
      if (!customData.gsModules) customData.gsModules = {};
      if (!customData.gsModules[name]) {
        customData.gsModules[name] = [];
      }
    } else if (type === 'gsSection') {
      if (!parentModule) return res.status(400).json({ error: "parentModule is required for GS sections." });
      if (!customData.gsModules) customData.gsModules = {};
      if (!customData.gsModules[parentModule]) {
        customData.gsModules[parentModule] = [];
      }
      const existingSec = customData.gsModules[parentModule].find(s => s.section === name);
      if (!existingSec) {
        customData.gsModules[parentModule].push({ section: name, topics: [] });
      }
    } else if (type === 'gsTopic') {
      if (!parentModule || !parentSection) {
        return res.status(400).json({ error: "parentModule and parentSection are required for GS topics." });
      }
      if (!customData.gsModules) customData.gsModules = {};
      if (!customData.gsModules[parentModule]) {
        customData.gsModules[parentModule] = [];
      }
      let existingSec = customData.gsModules[parentModule].find(s => s.section === parentSection);
      if (!existingSec) {
        existingSec = { section: parentSection, topics: [] };
        customData.gsModules[parentModule].push(existingSec);
      }
      if (!existingSec.topics) existingSec.topics = [];
      const existingTop = existingSec.topics.find(t => t.title === name);
      if (!existingTop) {
        existingSec.topics.push({ title: name });
      }
    } else if (type === 'optionalSubject') {
      if (!customData.optionalSubjects) customData.optionalSubjects = {};
      if (!customData.optionalSubjects[name]) {
        customData.optionalSubjects[name] = [];
      }
    } else if (type === 'optionalSection') {
      if (!parentModule) return res.status(400).json({ error: "parentModule (subject name) is required for optional sections." });
      if (!customData.optionalSubjects) customData.optionalSubjects = {};
      if (!customData.optionalSubjects[parentModule]) {
        customData.optionalSubjects[parentModule] = [];
      }
      const existingSec = customData.optionalSubjects[parentModule].find(s => s.section === name);
      if (!existingSec) {
        customData.optionalSubjects[parentModule].push({ section: name, topics: [] });
      }
    } else if (type === 'optionalTopic') {
      if (!parentModule || !parentSection) {
        return res.status(400).json({ error: "parentModule and parentSection are required for optional topics." });
      }
      if (!customData.optionalSubjects) customData.optionalSubjects = {};
      if (!customData.optionalSubjects[parentModule]) {
        customData.optionalSubjects[parentModule] = [];
      }
      let existingSec = customData.optionalSubjects[parentModule].find(s => s.section === parentSection);
      if (!existingSec) {
        existingSec = { section: parentSection, topics: [] };
        customData.optionalSubjects[parentModule].push(existingSec);
      }
      if (!existingSec.topics) existingSec.topics = [];
      const existingTop = existingSec.topics.find(t => t.title === name);
      if (!existingTop) {
        existingSec.topics.push({ title: name });
      }
    }
    
    fs.writeFileSync(customPath, JSON.stringify(customData, null, 2), 'utf8');
    res.status(200).json({ success: true, customData });
  } catch (error) {
    console.error("[DataController] Error adding custom tag:", error);
    res.status(500).json({ error: 'Failed to add custom tag.' });
  }
};
