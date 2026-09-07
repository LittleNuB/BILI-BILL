export function assistantStyles(CARD_ID: string): string {
  return `
#${CARD_ID} {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483646;
  box-sizing: border-box;
  color: var(--bb-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  letter-spacing: 0;
}
#${CARD_ID} * {
  box-sizing: border-box;
}
#${CARD_ID}.bdc-assistant-collapsed {
  width: min(300px, calc(100vw - 32px));
}
#${CARD_ID}.bdc-assistant-expanded {
  top: auto;
  bottom: 18px;
  width: min(420px, calc(100vw - 32px));
  height: min(620px, calc(100dvh - 90px));
}
#${CARD_ID} .bdc-assistant-shell,
#${CARD_ID} .bdc-assistant-panel {
  width: 100%;
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-surface);
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.14);
  overflow: hidden;
}
#${CARD_ID} .bdc-assistant-panel {
  display: flex;
  height: 100%;
  max-height: 100%;
  flex-direction: column;
}
#${CARD_ID} .bdc-assistant-body {
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  min-height: 0;
  flex: 1;
  padding: 16px 18px 18px;
}
#${CARD_ID} .bdc-assistant-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--bb-subtle);
}
#${CARD_ID} .bdc-assistant-brand {
  min-width: 0;
}
#${CARD_ID} .bdc-assistant-kicker {
  color: #fb7299;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-subtitle {
  margin-top: 2px;
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}
#${CARD_ID} .bdc-assistant-button,
#${CARD_ID} .bdc-assistant-link {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid var(--bb-line);
  background: var(--bb-subtle);
  color: var(--bb-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  padding: 6px 9px;
  text-decoration: none;
}
#${CARD_ID} .bdc-assistant-button-primary {
  border-color: transparent;
  background: var(--bb-accent);
  color: white;
}
#${CARD_ID} .bdc-assistant-button-quiet {
  color: var(--bb-secondary);
}
#${CARD_ID} .bdc-assistant-button:disabled {
  cursor: default;
  opacity: 0.55;
}
#${CARD_ID} .bdc-assistant-video-title {
  color: var(--bb-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 1.38;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-compact-status {
  padding: 0 12px 12px;
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.45;
}
#${CARD_ID} .bdc-assistant-section {
  margin-top: 14px;
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;
}
#${CARD_ID} .bdc-assistant-section-primary {
  background: transparent;
}
#${CARD_ID} .bdc-assistant-section-auxiliary {
  background: transparent;
}
#${CARD_ID} .bdc-assistant-section:first-child {
  margin-top: 0;
}
#${CARD_ID} .bdc-assistant-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
#${CARD_ID} .bdc-assistant-section-title {
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.45;
  margin-top: 5px;
}
#${CARD_ID} .bdc-assistant-row span:last-child {
  color: var(--bb-text);
  text-align: right;
}
#${CARD_ID} .bdc-assistant-muted {
  color: var(--bb-muted);
  font-size: 13px;
  line-height: 1.45;
}
#${CARD_ID} .bdc-assistant-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-pill {
  border: 1px solid var(--bb-line);
  border-radius: 999px;
  color: var(--bb-secondary);
  font-size: 13px;
  font-weight: 700;
  line-height: 1.2;
  padding: 4px 7px;
}
#${CARD_ID} .bdc-assistant-pill-ready {
  border-color: rgba(160, 231, 160, 0.30);
  color: var(--bb-success);
}
#${CARD_ID} .bdc-assistant-pill-warn {
  border-color: rgba(255, 207, 138, 0.32);
  color: var(--bb-warning);
}
#${CARD_ID} .bdc-assistant-tabs {
  display: grid;
  flex: none;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 0 18px;
  border-bottom: 1px solid var(--bb-line);
}
#${CARD_ID} .bdc-assistant-tab {
  min-width: 0;
  min-height: 40px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: var(--bb-secondary);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  padding: 10px 4px;
}
#${CARD_ID} .bdc-assistant-tab-active {
  border-bottom-color: var(--bb-accent);
  color: var(--bb-accent);
}
#${CARD_ID} .bdc-assistant-tab-panel {
  margin-top: 10px;
}
#${CARD_ID} .bdc-assistant-segmented-control {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
  overflow: hidden;
  border: 1px solid rgba(127, 219, 255, 0.28);
  border-radius: 8px;
  background: var(--bb-subtle);
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-segmented-option {
  min-width: 0;
  min-height: 34px;
  border: 0;
  border-right: 1px solid var(--bb-line);
  background: transparent;
  color: var(--bb-secondary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  padding: 7px 8px;
}
#${CARD_ID} .bdc-assistant-segmented-option:last-child {
  border-right: 0;
}
#${CARD_ID} .bdc-assistant-segmented-option-active {
  background: rgba(127, 219, 255, 0.16);
  color: var(--bb-text);
}
#${CARD_ID} .bdc-assistant-subtitle-text {
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.5;
}
#${CARD_ID} .bdc-assistant-subtitle-detail {
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.45;
  margin-top: 5px;
}
#${CARD_ID} .bdc-assistant-source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-source-card {
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  padding: 9px;
}
#${CARD_ID} .bdc-assistant-source-card-active {
  border-color: rgba(160, 231, 160, 0.32);
  background: rgba(160, 231, 160, 0.075);
}
#${CARD_ID} .bdc-assistant-source-card-viewing {
  border-color: rgba(127, 219, 255, 0.34);
}
#${CARD_ID} .bdc-assistant-source-title {
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-source-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-inline-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-status {
  color: var(--bb-link);
  font-size: 13px;
  line-height: 1.45;
  margin-top: 7px;
}
#${CARD_ID} .bdc-assistant-search-form {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
}
#${CARD_ID} .bdc-assistant-search-input {
  min-width: 0;
  width: 100%;
  min-height: 56px;
  flex: 1 1 auto;
  border: 1px solid var(--bb-line);
  border-radius: 6px;
  background: var(--bb-subtle);
  color: var(--bb-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
  padding: 9px 10px;
  resize: vertical;
}
#${CARD_ID} .bdc-assistant-search-input::placeholder {
  color: var(--bb-muted);
}
#${CARD_ID} .bdc-assistant-search-input:focus {
  border-color: rgba(251, 114, 153, 0.55);
  outline: none;
}
#${CARD_ID} .bdc-assistant-subtitle-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px;
  width: 100%;
}
#${CARD_ID} .bdc-assistant-subtitle-search-input {
  min-width: 0;
  min-height: 32px;
  border: 1px solid var(--bb-line);
  border-radius: 6px;
  background: var(--bb-subtle);
  color: var(--bb-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.35;
  padding: 7px 9px;
}
#${CARD_ID} .bdc-assistant-subtitle-search-input::placeholder {
  color: var(--bb-muted);
}
#${CARD_ID} .bdc-assistant-subtitle-search-input:focus {
  border-color: rgba(251, 114, 153, 0.55);
  outline: none;
}
#${CARD_ID} .bdc-assistant-subtitle-reader {
  max-height: min(48vh, 360px);
  overflow: auto;
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  margin-top: 10px;
}
#${CARD_ID} .bdc-assistant-subtitle-row {
  display: grid;
  width: 100%;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 8px;
  border: 0;
  border-bottom: 1px solid var(--bb-subtle);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 8px;
  text-align: left;
}
#${CARD_ID} .bdc-assistant-subtitle-row:last-child {
  border-bottom: 0;
}
#${CARD_ID} .bdc-assistant-subtitle-row-active {
  background: rgba(127, 219, 255, 0.11);
}
#${CARD_ID} .bdc-assistant-subtitle-row-preview {
  outline: 1px solid rgba(255, 179, 71, 0.40);
  outline-offset: -1px;
}
#${CARD_ID} .bdc-assistant-subtitle-time {
  color: var(--bb-link);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
}
#${CARD_ID} .bdc-assistant-subtitle-line-text {
  color: var(--bb-text);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-subtitle-results {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-subtitle-result {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  gap: 8px;
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 7px;
  text-align: left;
}
#${CARD_ID} .bdc-assistant-subtitle-result-active {
  border-color: rgba(255, 179, 71, 0.36);
  background: rgba(255, 179, 71, 0.08);
}
#${CARD_ID} .bdc-assistant-retrieval-status {
  font-size: 13px;
  line-height: 1.5;
  margin-top: 8px;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-answer-card {
  margin-top: 8px;
  border: 1px solid rgba(160, 231, 160, 0.20);
  border-radius: 8px;
  background: rgba(160, 231, 160, 0.07);
  padding: 9px;
}
#${CARD_ID} .bdc-assistant-answer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: var(--bb-success);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-answer-text {
  margin-top: 6px;
  color: var(--bb-text);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-citation-title {
  margin-top: 10px;
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-candidate-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-candidate-card {
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  padding: 9px;
}
#${CARD_ID} .bdc-assistant-candidate-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
#${CARD_ID} .bdc-assistant-candidate-title {
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-candidate-strength {
  flex: 0 0 auto;
  color: var(--bb-success);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  text-align: right;
}
#${CARD_ID} .bdc-assistant-candidate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}
#${CARD_ID} .bdc-assistant-candidate-evidence {
  margin-top: 7px;
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-candidate-reasons {
  margin: 7px 0 0;
  padding-left: 16px;
  color: var(--bb-link);
  font-size: 13px;
  line-height: 1.45;
}
#${CARD_ID} .bdc-assistant-candidate-reasons li {
  margin-top: 3px;
}
#${CARD_ID} .bdc-assistant-jump-status {
  margin-top: 8px;
  border: 1px solid rgba(127, 219, 255, 0.22);
  border-radius: 8px;
  background: rgba(127, 219, 255, 0.07);
  color: var(--bb-link);
  font-size: 13px;
  line-height: 1.5;
  padding: 8px;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-jump-preview {
  margin-top: 8px;
  border: 1px solid rgba(255, 179, 71, 0.30);
  border-radius: 8px;
  background: rgba(255, 179, 71, 0.08);
  padding: 8px;
}
#${CARD_ID} .bdc-assistant-jump-preview-title {
  color: var(--bb-warning);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
#${CARD_ID} .bdc-assistant-jump-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
#${CARD_ID} .bdc-assistant-button-warn {
  border-color: rgba(255, 179, 71, 0.42);
  background: #ffb347;
  color: #1f2433;
}
#${CARD_ID} .bdc-assistant-summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
#${CARD_ID} .bdc-assistant-badge {
  border-radius: 6px;
  background: rgba(251, 114, 153, 0.16);
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  padding: 4px 6px;
}
#${CARD_ID} .bdc-assistant-summary-text {
  color: var(--bb-text);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-list {
  margin: 8px 0 0;
  padding-left: 17px;
  color: var(--bb-secondary);
  font-size: 13px;
  line-height: 1.5;
}
#${CARD_ID} .bdc-assistant-list li {
  margin-top: 4px;
}
#${CARD_ID} .bdc-assistant-evidence {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--bb-subtle);
  color: var(--bb-link);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
#${CARD_ID} .bdc-assistant-session-list {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 2px 0 6px;
}
#${CARD_ID} .bdc-assistant-session-button {
  flex: 0 0 auto;
  max-width: 170px;
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  color: var(--bb-secondary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  padding: 7px 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${CARD_ID} .bdc-assistant-session-button-active {
  border-color: rgba(251, 114, 153, 0.62);
  background: rgba(251, 114, 153, 0.18);
  color: var(--bb-text);
}
#${CARD_ID} .bdc-assistant-question-card {
  border: 1px solid var(--bb-line);
  border-radius: 8px;
  background: var(--bb-subtle);
  padding: 9px;
  margin-top: 10px;
}
#${CARD_ID} .bdc-assistant-question-text {
  color: var(--bb-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

#${CARD_ID} {
  --bb-surface: #ffffff;
  --bb-subtle: #f6f7f8;
  --bb-text: #18191c;
  --bb-secondary: #61666d;
  --bb-muted: #737982;
  --bb-line: #e3e5e7;
  --bb-accent: #e65080;
  --bb-link: #0086b3;
  --bb-success: #238351;
  --bb-warning: #9b6300;
  color-scheme: light;
  font-size: 14px;
}
#${CARD_ID}[data-theme="dark"] {
  --bb-surface: #242628;
  --bb-subtle: #2f3134;
  --bb-text: #f1f2f3;
  --bb-secondary: #b7bbc1;
  --bb-muted: #a4a9b0;
  --bb-line: #44474c;
  --bb-accent: #fb7299;
  --bb-link: #65c6e6;
  --bb-success: #87ceaa;
  --bb-warning: #e3b76e;
  color-scheme: dark;
}
#${CARD_ID} button, #${CARD_ID} input, #${CARD_ID} textarea, #${CARD_ID} select {
  font-family: inherit;
  letter-spacing: 0;
}
#${CARD_ID} button:focus-visible, #${CARD_ID} a:focus-visible, #${CARD_ID} summary:focus-visible {
  outline: 2px solid var(--bb-link);
  outline-offset: 2px;
}
#${CARD_ID} button:hover:not(:disabled), #${CARD_ID} summary:hover {
  filter: brightness(.96);
}
#${CARD_ID} .bdc-assistant-compact {
  padding: 12px 14px 8px;
}
#${CARD_ID} .bdc-assistant-identity {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
#${CARD_ID} .bdc-assistant-identity .bdc-assistant-video-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.6;
}
#${CARD_ID} .bdc-assistant-part {
  flex: none;
  color: var(--bb-secondary);
  font-size: 12px;
}
#${CARD_ID} .bdc-assistant-compact-summary {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  line-height: 1.7;
  font-size: 14px;
  margin: 9px 0 3px;
  color: var(--bb-text);
}
#${CARD_ID} .bdc-assistant-compact-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}
#${CARD_ID} .bdc-assistant-expand {
  color: var(--bb-link);
  border: 0;
  background: transparent;
  font-weight: 400;
  gap: 4px;
  padding-inline: 4px;
}
#${CARD_ID} .bdc-assistant-header {
  padding: 10px 14px;
  border: 0;
  flex: none;
}
#${CARD_ID} .bdc-assistant-kicker {
  color: var(--bb-accent);
  font-size: 14px;
  font-weight: 600;
}
#${CARD_ID} .bdc-assistant-context-bar {
  padding: 0 18px 4px;
  flex: none;
}
#${CARD_ID} .bdc-assistant-icon-button {
  width: 32px;
  height: 32px;
  min-height: 32px;
  padding: 6px;
  border: 0;
  background: transparent;
  color: var(--bb-secondary);
}
#${CARD_ID} svg {
  width: 18px;
  height: 18px;
  display: block;
  flex: none;
}
#${CARD_ID} details > summary {
  list-style: none;
  cursor: pointer;
}
#${CARD_ID} details > summary::-webkit-details-marker { display: none; }
#${CARD_ID} .bdc-assistant-source-details { margin-top: 3px; }
#${CARD_ID} .bdc-assistant-source-details > summary {
  display: flex;
  align-items: center;
  width: fit-content;
  max-width: 100%;
  gap: 5px;
  min-height: 32px;
  color: var(--bb-secondary);
  font-size: 13px;
}
#${CARD_ID} .bdc-assistant-source-details > .bdc-assistant-section {
  margin: 0 0 6px;
  padding: 10px 0;
  max-height: min(220px, 30dvh);
  overflow: auto;
  border-top: 1px solid var(--bb-line);
}
#${CARD_ID} .bdc-assistant-source-card,
#${CARD_ID} .bdc-assistant-source-card-active,
#${CARD_ID} .bdc-assistant-answer-card,
#${CARD_ID} .bdc-assistant-candidate-card {
  background: transparent;
  border: 0;
  border-top: 1px solid var(--bb-line);
  border-radius: 0;
  padding: 12px 0;
}
#${CARD_ID} .bdc-assistant-source-actions { margin-top: 8px; }
#${CARD_ID} .bdc-assistant-subtitle-source-meta .bdc-assistant-badge {
  padding: 0;
  background: transparent;
  color: var(--bb-secondary);
  font-weight: 400;
}
#${CARD_ID} .bdc-assistant-summary-text,
#${CARD_ID} .bdc-assistant-answer-text,
#${CARD_ID} .bdc-assistant-subtitle-line-text {
  color: var(--bb-text);
  font-size: 14px;
  line-height: 1.8;
}
#${CARD_ID} .bdc-assistant-citation-title {
  color: var(--bb-text);
  font-weight: 600;
  margin: 18px 0 8px;
}
#${CARD_ID} .bdc-assistant-list {
  padding-left: 18px;
  color: var(--bb-text);
  font-size: 14px;
  line-height: 1.8;
}
#${CARD_ID} .bdc-assistant-list li { margin: 8px 0; }
#${CARD_ID} .bdc-assistant-body > .bdc-assistant-section { margin-top: 0; }
#${CARD_ID} .bdc-assistant-more { position: relative; }
#${CARD_ID} .bdc-assistant-more > summary {
  display: grid;
  place-items: center;
}
#${CARD_ID} .bdc-assistant-more-content {
  position: absolute;
  right: 0;
  top: 36px;
  width: 150px;
  padding: 6px;
  background: var(--bb-surface);
  border: 1px solid var(--bb-line);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0,0,0,.12);
  z-index: 2;
}
#${CARD_ID} .bdc-assistant-more-content .bdc-assistant-link {
  display: flex;
  border: 0;
  background: transparent;
  justify-content: flex-start;
  font-weight: 400;
}
#${CARD_ID} .bdc-assistant-generation-details {
  color: var(--bb-secondary);
  font-size: 12px;
  margin-bottom: 12px;
}
#${CARD_ID} .bdc-assistant-generation-details > summary {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-block: 4px;
}
#${CARD_ID} details[open] > summary > svg { transform: rotate(180deg); }
#${CARD_ID} .bdc-assistant-body:has(.bdc-assistant-subtitle-reader) { overflow: auto; display: flex; }
#${CARD_ID} .bdc-assistant-tab-panel:has(.bdc-assistant-subtitle-reader) { display: flex; flex-direction: column; min-height: 0; width: 100%; }
#${CARD_ID} .bdc-assistant-subtitle-reader { flex: 1; min-height: 70px; max-height: none; border: 0; border-radius: 0; background: transparent; }
@media (max-width: 560px) {
  #${CARD_ID} { right: 12px; bottom: 76px; }
  #${CARD_ID}.bdc-assistant-collapsed { width: min(300px, calc(100vw - 24px)); }
  #${CARD_ID}.bdc-assistant-expanded {
    top: auto;
    width: calc(100vw - 24px);
    height: min(620px, calc(100dvh - 140px));
    bottom: 76px;
  }
  #${CARD_ID} .bdc-assistant-body { padding: 12px 14px; }
  #${CARD_ID} .bdc-assistant-context-bar { padding-inline: 14px; }
  #${CARD_ID} .bdc-assistant-tabs { margin-inline: 14px; }
}
@media (max-height: 520px) {
  #${CARD_ID}.bdc-assistant-expanded { bottom: 12px; height: calc(100dvh - 24px); }
}
`;
}
