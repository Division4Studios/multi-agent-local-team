import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Trusted extension asset shared with diagram webviews and portable publications. */
export const WEBVIEW_THEME = readFileSync(join(__dirname, '../../media/maltTheme.css'), 'utf8');
