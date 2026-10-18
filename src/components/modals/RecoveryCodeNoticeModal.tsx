import { KeyRound } from "lucide-react";
import { Button, Dialog } from "../ui";

interface RecoveryCodeNoticeModalProps {
  /** What just happened: a password change, or a recovery that used the code. */
  reason: "password" | "recovery";
  /** The user wants a new recovery code now. The old one stops working at once. */
  onMakeNew: () => void;
  /** The user keeps the code they have. */
  onKeep: () => void;
}

/**
 * Changing the password does not change the recovery code, and neither does using it. The code
 * keeps opening the vault, so anyone who has seen it can still get in. This tells the user so
 * at the moment it matters, and offers the fix in one click.
 */
export function RecoveryCodeNoticeModal({ reason, onMakeNew, onKeep }: RecoveryCodeNoticeModalProps) {
  const changed = reason === "password";
  return (
    <Dialog
      title={changed ? "Password changed" : "Vault recovered"}
      icon={<KeyRound size={18} />}
      onClose={onKeep}
      actions={
        <>
          <Button variant="secondary" onClick={onKeep}>
            Keep my current code
          </Button>
          <Button variant="primary" onClick={onMakeNew}>
            Make a new recovery code
          </Button>
        </>
      }
    >
      {changed ? (
        <p>
          Your <strong>recovery code did not change</strong>. It still opens this vault, with or without your new
          password.
        </p>
      ) : (
        <p>
          You just used your recovery code, and <strong>it still works</strong>. Your new password does not replace it.
        </p>
      )}
      <p>
        If anyone else has seen the code, or you are not sure, make a new one now. The old code stops working at once,
        and you will be shown the new one to save.
      </p>
    </Dialog>
  );
}
