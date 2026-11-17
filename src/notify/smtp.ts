import { connect } from "node:net";

export interface SmtpOpts {
  host: string;
  port: number;
  from: string;
  to: string;
  subject: string;
  text: string;
  timeoutMs?: number;
}

function header(name: string, value: string): string {
  const v = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(v) ? `${name}: ${v}` : `${name}: =?UTF-8?B?${Buffer.from(v).toString("base64")}?=`;
}

/**
 * Plain SMTP, no AUTH and no STARTTLS. The park relay (mail-relais) accepts that
 * from tailnet hosts it already lists. The message never includes a password.
 */
export function sendMail(opts: SmtpOpts): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const body = opts.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const data = [
    header("From", opts.from),
    header("To", opts.to),
    header("Subject", opts.subject),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
    ".",
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const sock = connect({ host: opts.host, port: opts.port });
    const timer = setTimeout(() => finish(new Error("smtp timeout")), timeoutMs);
    let buf = "";
    let step = 0;
    let failed: Error | undefined;
    const finish = (err?: Error) => {
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const fail = (msg: string) => {
      failed = new Error(msg);
      try {
        sock.write("QUIT\r\n");
      } catch {
        finish(failed);
      }
    };
    const next = () => {
      if (failed) return finish(failed);
      if (step === 0) sock.write("EHLO dozzle-reporting\r\n");
      else if (step === 1) sock.write(`MAIL FROM:<${opts.from}>\r\n`);
      else if (step === 2) sock.write(`RCPT TO:<${opts.to}>\r\n`);
      else if (step === 3) sock.write("DATA\r\n");
      else if (step === 4) sock.write(data + "\r\n");
      else if (step === 5) sock.write("QUIT\r\n");
      else finish();
      step++;
    };
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      let ready = false;
      let code = 0;
      for (const line of lines) {
        if (/^\d{3} /.test(line)) {
          ready = true;
          code = Number(line.slice(0, 3));
        }
      }
      if (!ready) return;
      const expect = step === 0 ? 220 : step === 4 ? 354 : step === 6 ? 221 : 250;
      if (code !== expect) return fail(`smtp ${code}`);
      next();
    });
    sock.on("error", (e) => finish(e));
    sock.on("connect", () => {
      /* banner arrives as data */
    });
  });
}
