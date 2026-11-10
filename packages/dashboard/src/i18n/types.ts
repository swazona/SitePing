/** All translatable string keys used by the dashboard inbox. */
export interface Translations {
  // Inbox chrome
  "inbox.regionLabel": string;
  "inbox.listLabel": string;
  "inbox.statusFilter": string;
  "inbox.searchPlaceholder": string;
  "inbox.searchAria": string;
  "inbox.clearSearch": string;
  /** Screen-reader announcement of the visible result count. */
  "inbox.resultsCount": string;
  "inbox.typeFilter": string;
  "inbox.typeAll": string;
  "inbox.project": string;
  "inbox.refresh": string;
  "inbox.loadMore": string;

  // Empty / error states
  "inbox.emptyTitle": string;
  "inbox.emptySub": string;
  "inbox.emptyFilteredTitle": string;
  "inbox.emptyFilteredSub": string;
  "inbox.viewAll": string;
  "inbox.inboxZeroTitle": string;
  "inbox.inboxZeroSub": string;
  "inbox.loadError": string;
  "inbox.retry": string;

  // Actions & toasts
  "inbox.cancel": string;
  "inbox.undo": string;
  "inbox.actionFailed": string;
  "inbox.copied": string;
  "inbox.markedAs": string;
  "inbox.deleted": string;

  // Status labels
  "status.all": string;
  "status.open": string;
  "status.in_progress": string;
  "status.resolved": string;
  "status.wont_fix": string;

  // Feedback type labels
  "type.question": string;
  "type.change": string;
  "type.bug": string;
  "type.other": string;

  // Drawer
  "drawer.title": string;
  "drawer.close": string;
  "drawer.openOnPage": string;
  "drawer.status": string;
  "drawer.author": string;
  "drawer.page": string;
  "drawer.viewport": string;
  "drawer.submitted": string;
  "drawer.browser": string;
  "drawer.anchor": string;
  "drawer.diagnostics": string;
  "drawer.showAllDiagnostics": string;
  "drawer.hideAnnotation": string;
  "drawer.showAnnotation": string;
  "drawer.screenshotAlt": string;
  "drawer.zoomScreenshot": string;
  "drawer.noScreenshot": string;
  "drawer.delete": string;
  "drawer.deleteConfirm": string;
  "drawer.deleteYes": string;

  // Discussion thread — deleting a reply reuses "drawer.deleteYes" and "inbox.cancel"
  "comments.title": string;
  /** Badge on a reply from the project team. */
  "comments.team": string;
  "comments.placeholder": string;
  "comments.send": string;
  "comments.delete": string;
  "comments.failed": string;

  // Footer hint bar
  "hints.navigate": string;
  "hints.open": string;
  "hints.resolve": string;
  "hints.inProgress": string;
  "hints.wontFix": string;
  "hints.help": string;

  // Keyboard shortcuts overlay
  "shortcuts.title": string;
  "shortcuts.close": string;

  // Export dialog — closing reuses "shortcuts.close", the copy toast "inbox.copied"
  "export.open": string;
  "export.title": string;
  "export.format": string;
  "export.formatText": string;
  "export.formatPrompt": string;
  "export.sections": string;
  "export.section.location": string;
  "export.section.environment": string;
  "export.section.screenshot": string;
  "export.section.console": string;
  "export.section.network": string;
  "export.section.thread": string;
  "export.section.author": string;
  "export.redact": string;
  "export.redact.secrets": string;
  "export.redact.emails": string;
  "export.redact.queryStrings": string;
  "export.redact.authorName": string;
  "export.redact.userAgent": string;
  "export.selectedCount": string;
  "export.selectAll": string;
  "export.preview": string;
  "export.nothingSelected": string;
  "export.copy": string;
  "export.download": string;

  // Relative time
  "time.now": string;
  "time.minutes": string;
  "time.hours": string;
  "time.days": string;
  "time.weeks": string;
  "time.month": string;
  "time.months": string;
  "time.year": string;
  "time.years": string;
}

/** Every valid key of `Translations` as a string-literal union. */
export type TranslationKey = keyof Translations;

/** A translate function that returns the string for a given key. */
export type TFunction = (key: TranslationKey) => string;
