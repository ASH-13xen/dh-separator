// Merges a saved BookLayout document (per paper) into a freshly-built CSV-derived
// hierarchy: applies topic renames/order, question order, and topper detail overrides,
// then derives the excluded-question-id list and topper-selection map the frontend needs
// to initialize its checkboxes/selects. Topics not present in a saved layout (new topics
// added since the layout was last saved) are appended after the ordered ones; same for
// questions within a topic. This keeps newly-added questions/topics visible by default
// while still respecting everything the user previously customized.

export function applyBookLayout(hierarchy, layoutsByPaper) {
  return hierarchy.map((paperNode) => {
    const layout = layoutsByPaper[paperNode.paper];
    if (!layout) return paperNode;

    const renames = layout.topicRenames || {};
    const questionOrders = layout.questionOrder || {};
    const topperOverrides = layout.topperOverrides || {};

    let topics = paperNode.topics.map((topic) => {
      const order = questionOrders[topic._key];
      let questions = topic.questions;
      if (order && order.length) {
        const byId = new Map(questions.map((q) => [q._id, q]));
        const orderedIds = new Set(order);
        const ordered = order.map((id) => byId.get(id)).filter(Boolean);
        const remaining = questions.filter((q) => !orderedIds.has(q._id));
        questions = [...ordered, ...remaining];
      }

      questions = questions.map((q) => ({
        ...q,
        file_urls: (q.file_urls || []).map((f) => {
          const override = topperOverrides[f.url];
          return override ? { ...f, ...override } : f;
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

export function deriveIncludedAndSelections(hierarchy, layoutsByPaper) {
  const excludedQuestionIds = [];
  const selections = {};

  hierarchy.forEach((paperNode) => {
    const layout = layoutsByPaper[paperNode.paper];
    const excludedSet = new Set(layout?.excludedQuestionIds || []);
    const savedSelections = layout?.selections || {};

    paperNode.topics.forEach((topic) => {
      topic.questions.forEach((q) => {
        if (excludedSet.has(q._id)) excludedQuestionIds.push(q._id);
        const saved = savedSelections[q._id];
        selections[q._id] = saved && saved.length ? saved : (q.file_urls?.length > 0 ? [q.file_urls[0].url] : []);
      });
    });
  });

  return { excludedQuestionIds, selections };
}
