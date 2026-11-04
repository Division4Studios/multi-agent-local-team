/**
 * Keeps MALT from pulling the user away from what they are investigating. Auto-open (bringing newly changed files
 * into view) only happens after the user has been idle for a while; any sign that they are working (clicking or
 * typing in an editor, scrolling, switching files, or opening something from MALT) restarts the quiet period.
 * MALT's own navigation is excluded, so an auto-open never counts as user activity.
 */
import * as vscode from 'vscode';

/** Events that arrive just after MALT navigates are MALT's, not the user's. */
const OWN_NAVIGATION_GRACE_MS = 400;

export class AttentionGuard implements vscode.Disposable {
  private lastUserActivity = Number.NEGATIVE_INFINITY;
  private ownNavigationUntil = 0;
  private readonly disposables: vscode.Disposable[];
  private readonly quietMs: () => number;
  private readonly now: () => number;

  public constructor(quietMs: () => number, now: () => number = Date.now) {
    this.quietMs = quietMs;
    this.now = now;
    this.disposables = [
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
          this.noteUserActivity();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        this.noteActivityUnlessOwn();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.noteActivityUnlessOwn();
      }),
    ];
  }

  /** The user did something deliberate (including opening something from MALT). */
  public noteUserActivity(): void {
    this.lastUserActivity = this.now();
  }

  /** Whether MALT may bring a changed file into view now. */
  public allowsAutoOpen(): boolean {
    return this.now() - this.lastUserActivity >= this.quietMs();
  }

  /** Runs MALT-initiated navigation so the editor events it causes are not mistaken for the user's. */
  public async navigate(action: () => Promise<void>): Promise<void> {
    this.ownNavigationUntil = Number.POSITIVE_INFINITY;
    try {
      await action();
    } finally {
      this.ownNavigationUntil = this.now() + OWN_NAVIGATION_GRACE_MS;
    }
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private noteActivityUnlessOwn(): void {
    if (this.now() > this.ownNavigationUntil) {
      this.noteUserActivity();
    }
  }
}
