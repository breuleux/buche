export class History {
  // getPrompts: () => Prompt[]
  // getActive:  () => Prompt
  // activate:   (prompt: Prompt) => void
  constructor({ buche, getPrompts, getActive, activate }) {
    this._buche = buche;
    this._entries = [];
    this._idx = -1; // -1 = not navigating
    this._drafts = null; // Map<Prompt, string> — saved texts for all prompts at nav start
    this._draftActive = null; // Prompt that was active when navigation started
    this._getPrompts = getPrompts;
    this._getActive = getActive;
    this._activate = activate;

    buche.history.get().then((entries) => {
      this._entries = entries;
    });
  }

  // Append an entry, skipping consecutive duplicates. Resets navigation.
  push(entry) {
    this._idx = -1;
    this._drafts = null;
    this._draftActive = null;
    const last = this._entries[this._entries.length - 1];
    if (!last || last.text !== entry.text || last.tag !== entry.tag) {
      this._entries.push(entry);
      this._buche.history.add(entry);
    }
  }

  // Reset navigation state without appending (called on free-form user input).
  cancelNavigation() {
    this._idx = -1;
    this._drafts = null;
    this._draftActive = null;
  }

  // For Up/Down: find the first prompt that an entry would activate.
  _findPromptFor(entry) {
    const prompts = this._getPrompts();
    if (entry.target_cell_id != null) {
      const p = prompts.find((p) => p.targetCellId === entry.target_cell_id);
      if (p) return p;
    }
    if (entry.tag != null) {
      const p = prompts.find((p) => p.tag === entry.tag);
      if (p) return p;
    }
    return null;
  }

  // For Alt+Up/Down: check whether a specific prompt matches an entry directly,
  // without searching
  _resolvePromptFor(entry, forPrompt) {
    if (
      entry.target_cell_id !== null &&
      entry.target_cell_id === forPrompt.targetCellId
    ) {
      return forPrompt;
    }
    if (entry.tag !== null && entry.tag === forPrompt.tag) {
      return forPrompt;
    }
    return null;
  }

  // Navigate to the previous matching entry.
  // forPrompt=null (Up): finds any matching prompt, may switch tabs.
  // forPrompt=p (Alt+Up): only matches entries that belong to p.
  // filter: if set, only entries whose text includes filter are considered.
  prev(forPrompt = null, filter = null) {
    if (this._idx === -1) {
      this._drafts = new Map(this._getPrompts().map((p) => [p, p.getValue()]));
      this._draftActive = this._getActive();
      this._idx = this._entries.length;
    }
    for (let i = this._idx - 1; i >= 0; i--) {
      const entry = this._entries[i];
      if (filter && !entry.text.includes(filter)) continue;
      const prompt = forPrompt
        ? this._resolvePromptFor(entry, forPrompt)
        : this._findPromptFor(entry);
      if (prompt) {
        this._idx = i;
        this._activate(prompt);
        prompt.setValue(entry.text);
        prompt.selectSubstring(filter);
        return;
      }
    }
  }

  // Navigate to the next matching entry, restoring the draft when past the end.
  // forPrompt=null (Down): finds any matching prompt, may switch tabs.
  // forPrompt=p (Alt+Down): only matches entries that belong to p.
  // filter: if set, only entries whose text includes filter are considered.
  next(forPrompt = null, filter = null) {
    if (this._idx === -1) return;
    for (let i = this._idx + 1; i < this._entries.length; i++) {
      const entry = this._entries[i];
      if (filter && !entry.text.includes(filter)) continue;
      const prompt = forPrompt
        ? this._resolvePromptFor(entry, forPrompt)
        : this._findPromptFor(entry);
      if (prompt) {
        this._idx = i;
        this._activate(prompt);
        prompt.setValue(entry.text);
        prompt.selectSubstring(filter);
        return;
      }
    }
    // Past the newest entry — restore the drafts.
    const drafts = this._drafts;
    const draftActive = this._draftActive;
    this._idx = -1;
    this._drafts = null;
    this._draftActive = null;
    if (drafts) {
      for (const [prompt, text] of drafts) {
        prompt.setValue(text);
      }
    }
    if (draftActive) {
      this._activate(draftActive);
    }
  }
}
