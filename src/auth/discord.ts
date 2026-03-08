import crypto from "crypto";
import { Router, Request, Response, NextFunction } from "express";
import passport from "passport";
import { pool } from "../db";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";

dotenv.config();
const router = Router();

/* ───── Define basic Discord user shape ───── */
type DiscordUser = {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string | null;
  global_name?: string | null;
};

/* ───── Set up Passport serialization ───── */
passport.serializeUser((user: any, done: (err: any, user?: any) => void) => {
  done(null, user);
});

passport.deserializeUser((obj: any, done: (err: any, user?: any) => void) => {
  done(null, obj as DiscordUser);
});

function base64UrlDecode(input: string): Buffer {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifySignedPayload(value: string, secret: string): any {
  const parts = value.split(".");
  if (parts.length !== 2) {
    throw new Error("Malformed payload");
  }

  const [payload, signature] = parts;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  if (!timingSafeEqualStr(signature, expected)) {
    throw new Error("Invalid signature");
  }

  const json = base64UrlDecode(payload).toString("utf8");
  return JSON.parse(json);
}

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

/* ───── Routes ───── */

router.get(
  "/discord",
  loginLimiter,
  (req: Request, res: Response) => {
    const redirect = req.query.redirect as string | undefined;

    try {
      if (redirect) {
        const url = new URL(redirect);
        const allowedDomains = ["cipher.uno", "draft.cipher.uno", "haya-pvp.vercel.app"];

        if (
          allowedDomains.some(
            (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
          )
        ) {
          (req.session as any).oauthRedirect = redirect;
        }
      }
    } catch (err) {
      console.warn("⚠️ Invalid redirect URL:", redirect);
    }

    const workerStart = new URL(process.env.CLOUDFLARE_WORKER_DISCORD_URL as string);
    workerStart.searchParams.set(
      "backend_complete",
      process.env.DISCORD_BACKEND_COMPLETE_URL as string
    );

    return res.redirect(workerStart.toString());
  }
);

router.get(
  "/discord/complete",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const payload = req.query.payload as string | undefined;
      if (!payload) {
        return res.status(400).send("Missing payload");
      }

      const parsed = verifySignedPayload(
        payload,
        process.env.WORKER_SHARED_SECRET as string
      );

      const ageMs = Date.now() - Number(parsed.ts || 0);
      if (ageMs > 10 * 60 * 1000) {
        return res.status(400).send("Payload expired");
      }

      const user = parsed.user as DiscordUser | undefined;
      if (!user?.id) {
        return res.status(400).send("Invalid user payload");
      }

      const globalName = user.global_name ?? null;

      try {
        await pool.query(
          `INSERT INTO discord_usernames (discord_id, username, global_name, avatar)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (discord_id) DO UPDATE
           SET username    = EXCLUDED.username,
               global_name = EXCLUDED.global_name,
               avatar      = EXCLUDED.avatar`,
          [user.id, user.username, globalName, user.avatar ?? null]
        );
      } catch (err) {
        console.error("❌ Failed to upsert discord_usernames:", err);
      }

      req.logIn(user, (loginErr: any) => {
        if (loginErr) {
          console.error("Login error:", loginErr);
          return next(loginErr);
        }

        const session = req.session as typeof req.session & {
          oauthRedirect?: string;
        };

        const redirect = session.oauthRedirect;
        if (redirect) delete session.oauthRedirect;

        return res.redirect(redirect || process.env.FRONTEND_HOME_URL!);
      });
    } catch (err: any) {
      console.error("OAuth complete error:", err);
      return res.status(500).send("OAuth failed");
    }
  }
);

router.get("/auth/failure", (_req: Request, res: Response) => {
  res.send("OAuth failure occurred — check server logs for details.");
});

router.get("/me", async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }

  const baseUser = req.user as DiscordUser;

  try {
    let avatar = baseUser.avatar;
    if (!avatar) {
      const avatarResult = await pool.query(
        `SELECT avatar FROM discord_usernames WHERE discord_id = $1`,
        [baseUser.id]
      );
      avatar = avatarResult.rows[0]?.avatar ?? null;
    }

    let isAdmin = false;
    try {
      const adminResult = await pool.query(
        `SELECT 1 FROM admin_users WHERE discord_id = $1`,
        [baseUser.id]
      );
      isAdmin = !!adminResult?.rowCount;
    } catch (adminErr) {
      console.error("Error checking admin status:", adminErr);
    }

    res.json({
      user: {
        ...baseUser,
        avatar,
        isAdmin,
      },
    });
  } catch (err) {
    console.error("Error fetching user data:", err);
    res.json({ user: { ...baseUser } });
  }
});

router.post("/logout", (req: Request, res: Response) => {
  req.logout((err) => {
    if (err) {
      console.error("❌ Logout error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }

    req.session.destroy(() => {
      res.clearCookie("cid", {
        path: "/",
        domain: process.env.NODE_ENV === "production" ? ".cipher.uno" : undefined,
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        secure: process.env.NODE_ENV === "production",
      });

      res.status(200).json({ message: "Logged out" });
    });
  });
});

export { router as discordAuthRouter };