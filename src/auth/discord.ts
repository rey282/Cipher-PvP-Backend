import { Router, Request, Response } from "express";
import passport from "passport";
import { Strategy as DiscordStrategy } from "passport-discord";
import { Profile as PassportProfile } from "passport";
import { pool } from "../db"; 
import dotenv from "dotenv";

dotenv.config();
const router = Router();

/* ───── Define basic Discord user shape ───── */
type DiscordUser = {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string | null;
};

/* ───── Set up Passport serialization ───── */
passport.serializeUser((user: any, done) => {
  done(null, user);
});

passport.deserializeUser((obj: any, done) => {
  done(null, obj as DiscordUser);
});

interface DiscordProfile extends PassportProfile {
  id: string;
  username?: string;
  discriminator?: string;
  avatar?: string | null;
  _json?: {
    avatar?: string | null;
  };
}

/* ───── Configure Discord Strategy ───── */
passport.use(
  new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID as string,
      clientSecret: process.env.DISCORD_CLIENT_SECRET as string,
      callbackURL: process.env.DISCORD_REDIRECT_URI as string,
      scope: ["identify"],
    },
    async (
      _accessToken: string,
      _refreshToken: string,
      profile: DiscordProfile,
      done: (error: any, user?: any) => void
    ) => {
      const user: DiscordUser = {
        id: profile.id,
        username: profile.displayName ?? profile.username ?? "Unknown",
        discriminator: profile.discriminator ?? "0000",
        avatar: profile.avatar ?? profile._json?.avatar ?? null,
        };

      // ✅ Upsert to DB
      try {
        await pool.query(
          `INSERT INTO discord_usernames (discord_id, username, avatar)
          VALUES ($1, $2, $3)
          ON CONFLICT (discord_id) DO UPDATE
          SET username = EXCLUDED.username,
              avatar   = EXCLUDED.avatar`,
          [user.id, user.username, user.avatar]
        );
      } catch (err) {
        console.error("❌ Failed to upsert discord_usernames:", err);
      }

      return done(null, user);
    }
  )
);

/* ───── Routes ───── */

router.get("/discord", (req, res, next) => {
  const redirect = req.query.redirect as string | undefined;
  if (redirect) {
    req.session.oauthRedirect = redirect;
  }
  passport.authenticate("discord")(req, res, next);
});

router.get(
  "/discord/callback",
  passport.authenticate("discord", { failureRedirect: process.env.FRONTEND_HOME_URL }),
  (req: Request, res: Response) => {
    const session = req.session as typeof req.session & { oauthRedirect?: string };
    const rawRedirect = session.oauthRedirect;
    delete session.oauthRedirect;

    let finalUrl = process.env.FRONTEND_HOME_URL!; // fallback

    if (typeof rawRedirect === "string") {
      try {
        const url = new URL(rawRedirect); // if it fails, it’s not a full URL
        const allowed = ["cipher.uno", "draft.cipher.uno"];
        if (allowed.some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) {
          finalUrl = rawRedirect;
        }
      } catch {
        // optional: allow relative paths like "/players"
        if (rawRedirect.startsWith("/")) {
          finalUrl = process.env.FRONTEND_HOME_URL!.replace(/\/+$/, "") + rawRedirect;
        }
      }
    }

    console.log("🔁 Redirecting to:", finalUrl);
    res.redirect(finalUrl);
  }
);




router.get("/me", async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }

  const baseUser = req.user as DiscordUser;

  if (baseUser.avatar) {
    res.json({ user: baseUser });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT avatar FROM discord_usernames WHERE discord_id = $1`,
      [baseUser.id]
    );
    const avatar = result.rows[0]?.avatar ?? null;
    res.json({ user: { ...baseUser, avatar } });
  } catch (err) {
    console.error("Error fetching avatar from DB:", err);
    res.json({ user: baseUser });
  }
});

// ───── Logout Route ─────
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
