import { onLanguageChange, t } from "../i18n";
import type { LoreJournal } from "../world/loreJournal";
import { confirmPairing, currentIdentity, onIdentityChange, restoreFromCode, startPairing, type PairingRequest } from "../world/playerIdentity";

/**
 * Section "Enregistrement" de la page d'accueil (avant d'entrer en VR, où le clavier du
 * navigateur est disponible) : code de cassette de cet appareil, récupération d'un
 * enregistrement par son code, et jumelage façon télé (les deux sens).
 */
export function installAccountPanel(lore: LoreJournal): void {
  const code = document.querySelector<HTMLElement>("#account-code");
  const status = document.querySelector<HTMLElement>("#account-status");
  const restoreInput = document.querySelector<HTMLInputElement>("#restore-input");
  const pairCode = document.querySelector<HTMLElement>("#pair-code");
  const pairInput = document.querySelector<HTMLInputElement>("#pair-input");
  if (!code || !status || !restoreInput || !pairCode || !pairInput) return;

  let pairing: PairingRequest | null = null;
  const showCode = (): void => {
    code.textContent = lore.serverProfile?.recoveryCode ?? currentIdentity()?.recoveryCode ?? t("account.offline");
  };
  const say = (text: string, good: boolean): void => {
    status.textContent = text;
    status.style.color = good ? "#9fe39f" : "#ff9a8a";
  };
  lore.onChange(showCode);
  onIdentityChange(showCode);
  onLanguageChange(showCode);
  showCode();

  document.querySelector("#restore-button")?.addEventListener("click", () => {
    void restoreFromCode(restoreInput.value).then(async (ok) => {
      say(ok ? t("account.restored") : t("account.restoreFailed"), ok);
      if (ok) {
        restoreInput.value = "";
        await lore.sync();
      }
    });
  });

  document.querySelector("#pair-start")?.addEventListener("click", () => {
    pairing?.cancel();
    pairCode.textContent = "…";
    void startPairing((success) => {
      pairing = null;
      pairCode.textContent = "";
      say(success ? t("pair.success") : t("pair.failed"), success);
      if (success) void lore.sync();
    }).then((request) => {
      pairing = request;
      if (request) pairCode.textContent = t("account.pairCode", { code: `${request.code.slice(0, 3)} ${request.code.slice(3)}` });
      else {
        pairCode.textContent = "";
        say(t("pair.unavailable"), false);
      }
    });
  });

  document.querySelector("#pair-confirm")?.addEventListener("click", () => {
    const digits = pairInput.value.replace(/\D/g, "");
    void confirmPairing(digits).then((ok) => {
      say(ok ? t("pair.confirmed") : t("pair.badCode"), ok);
      if (ok) {
        pairInput.value = "";
        void lore.sync();
      }
    });
  });
}
