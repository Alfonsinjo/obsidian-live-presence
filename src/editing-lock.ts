import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { Notice } from "obsidian";

// A live connection is always required to edit synced notes. While offline we
// block every user edit so nothing is written locally that could later be lost
// or cause a merge conflict. The user is told to use a private scratch document
// instead and paste the content back once reconnected.
//
// Only user-originated edits are blocked. Programmatic document changes (remote
// sync updates applied when the connection returns, or the plugin's own writes)
// carry no user-event annotation and must still pass, or syncing would break.

let online = true;
let lastNotice = 0;

export function setEditingOnline(value: boolean): void {
  online = value;
}

export function isEditingOnline(): boolean {
  return online;
}

function isUserEdit(tr: Transaction): boolean {
  const ue = tr.annotation(Transaction.userEvent);
  return ue != null && (ue.startsWith("input") || ue.startsWith("delete") || ue === "move");
}

export function editingLockExtension(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (online || !tr.docChanged || !isUserEdit(tr)) return tr;
    // Inform the user, but at most every few seconds so held keys do not spam.
    const now = Date.now();
    if (now - lastNotice > 4000) {
      lastNotice = now;
      new Notice(
        "Offline: Bearbeitung gesperrt. Zum Schreiben ist eine Verbindung erforderlich. " +
          "Bitte notieren Sie Ihren Text vorerst extern und fügen Sie ihn später ein.",
        4000,
      );
    }
    return []; // cancel the user edit
  });
}
