import { cleanYear } from './csv.js';

// Merges a saved BookLayout document (per paper) into a freshly-built CSV-derived
// hierarchy: applies topic renames/order, question order, and topper detail overrides,
// then derives the excluded-question-id list and topper-selection map the frontend needs
// to initialize its checkboxes/selects. Topics not present in a saved layout (new topics
// added since the layout was last saved) are appended after the ordered ones; same for
// questions within a topic. This keeps newly-added questions/topics visible by default
// while still respecting everything the user previously customized.
//
// Note: cleanYear() is applied to topper_year at merge time (display-only) — it strips a
// trailing ".0" from spreadsheet-exported years without ever rewriting the stored override.

export function applyBookLayout(hierarchy, layoutsByPaper) {
  return hierarchy.map((paperNode) => {
    const layout = layoutsByPaper[paperNode.paper];
    if (!layout) return paperNode;

    const renames = layout.topicRenames || {};
    const questionOrders = layout.questionOrder || {};
    const topperOverrides = layout.topperOverrides || {};
    const questionTextOverrides = layout.questionTextOverrides || {};
    const titlePages = layout.titlePages || {};

    let topics = paperNode.topics.map((topic) => {
      const order = questionOrders[topic._key];
      let questions = topic.questions;
      if (order && order.length) {
        const byId = new Map(questions.map((q) => [q._id, q]));
        const orderedIds = new Set(order);
        // An id in the saved order that isn't a real CSV question is a user-inserted
        // title page (divider) — synthesize it here instead of silently dropping it.
        const ordered = order.map((id) => {
          if (byId.has(id)) return byId.get(id);
          const tp = titlePages[id];
          if (tp) return { _id: id, isTitlePage: true, subtitle: tp.subtitle, question_text: tp.subtitle, file_urls: [] };
          return null;
        }).filter(Boolean);
        const remaining = questions.filter((q) => !orderedIds.has(q._id));
        questions = [...ordered, ...remaining];
      }

      questions = questions.map((q) => ({
        ...q,
        question_text: questionTextOverrides[q._id] || q.question_text,
        file_urls: (q.file_urls || []).map((f) => {
          const override = topperOverrides[f.url];
          const merged = override ? { ...f, ...override } : f;
          return { ...merged, topper_year: cleanYear(merged.topper_year) };
        }),
      }));

      return { ...topic, title: renames[topic._key] || topic.title, questions };
    });

    if (layout.topicOrder && layout.topicOrder.length) {
      const byKey = new Map(topics.map((t) => [t._key, t]));
      const orderedKeys = new Set(layout.topicOrder);
      const ordered = layout.topicOrder.map((key) => byKey.get(key)).filter(Boolean);
      const remaining = topics.filter((t) => !orderedKeys.has(t._key));
      topics = [...ordered, ...remaining];
    }

    return { ...paperNode, topics };
  });
}

// Ensures every Paper > Section > Topic node from the subject's authored syllabus is
// visible in the book-builder editor, even when no question has ever been classified
// into it — the editor should reflect the full syllabus, not just the slice of it that
// happens to have questions so far. This only ever ADDS placeholder topics/papers (with
// an empty `questions` array); every CSV-derived paper/topic/question that already exists
// is kept exactly as-is. It never removes anything, and it runs only on the preview/editor
// read path — book generation rebuilds its own topic map strictly from the user's selected
// `includedQuestionIds`, so an empty placeholder topic naturally contributes nothing to the
// compiled PDF without any changes needed there.
export function mergeSyllabusIntoHierarchy(hierarchy, syllabusJson) {
  if (!Array.isArray(syllabusJson) || syllabusJson.length === 0) return hierarchy;

  const hierarchyByPaper = new Map(hierarchy.map((p) => [p.paper, p]));
  const result = [];

  syllabusJson.forEach((paperDef) => {
    const paperName = (paperDef.name || '').trim();
    if (!paperName) return;

    const existingPaper = hierarchyByPaper.get(paperName);
    const topicsByKey = new Map((existingPaper?.topics || []).map((t) => [t._key, t]));
    const usedKeys = new Set();
    const orderedTopics = [];

    (paperDef.sections || []).forEach((sectionDef) => {
      (sectionDef.topics || []).forEach((topicName) => {
        const title = (topicName || '').trim();
        if (!title || usedKeys.has(title)) return;
        usedKeys.add(title);
        orderedTopics.push(topicsByKey.get(title) || { title, _key: title, questions: [] });
      });
    });

    // Keep any CSV-derived topic the syllabus doesn't (or no longer) account for — e.g.
    // an "Unassigned" fallback bucket — so a classified question is never hidden.
    (existingPaper?.topics || []).forEach((t) => {
      if (!usedKeys.has(t._key)) {
        usedKeys.add(t._key);
        orderedTopics.push(t);
      }
    });

    result.push({
      paper: paperName,
      section: existingPaper?.section || (paperDef.sections || [])[0]?.name || '',
      topics: orderedTopics,
    });
    hierarchyByPaper.delete(paperName);
  });

  // Any CSV-derived paper the syllabus doesn't mention at all (e.g. renamed after
  // questions were already classified) — keep it appended rather than losing the data.
  hierarchyByPaper.forEach((paperNode) => result.push(paperNode));

  return result;
}

export function deriveIncludedAndSelections(hierarchy, layoutsByPaper) {
  const excludedQuestionIds = [];
  const selections = {};
  const expandedTopicTitles = [];

  hierarchy.forEach((paperNode) => {
    const layout = layoutsByPaper[paperNode.paper];
    const excludedSet = new Set(layout?.excludedQuestionIds || []);
    const expandedKeySet = new Set(layout?.expandedTopics || []);
    const savedSelections = layout?.selections || {};

    paperNode.topics.forEach((topic) => {
      if (expandedKeySet.has(topic._key)) expandedTopicTitles.push(topic.title);
      topic.questions.forEach((q) => {
        if (q.isTitlePage) return; // title pages have no exclusion/selection state
        if (excludedSet.has(q._id)) excludedQuestionIds.push(q._id);
        // A saved selection of [] means the user deliberately deselected every topper for
        // this question — that must be respected, not treated as "no saved selection".
        // Only fall back to the default (first topper) when nothing was ever saved at all.
        const saved = savedSelections[q._id];
        selections[q._id] = saved !== undefined ? saved : (q.file_urls?.length > 0 ? [q.file_urls[0].url] : []);
      });
    });
  });

  return { excludedQuestionIds, selections, expandedTopicTitles };
}
