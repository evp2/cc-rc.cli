import qrcodeTerminal from "qrcode-terminal";

/** Renders a scannable QR code for the pairing URL to stdout. */
export function printPairingQrCode(phoneUrl: string): void {
  qrcodeTerminal.generate(phoneUrl, { small: true });
}
