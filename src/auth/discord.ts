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
  global_name?: string | null;
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
      const globalName = (profile as any).global_name ?? null;

      const user: DiscordUser = {
        id: profile.id,
        username: profile.displayName ?? profile.username ?? "Unknown",
        discriminator: profile.discriminator ?? "0000",
        avatar: profile.avatar ?? profile._json?.avatar ?? null,
        global_name: globalName,
      };

      // ✅ Upsert to DB
      try {
        await pool.query(
          `INSERT INTO discord_usernames (discord_id, username, global_name, avatar)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (discord_id) DO UPDATE
           SET username     = EXCLUDED.username,
               global_name  = EXCLUDED.global_name,
               avatar       = EXCLUDED.avatar`,
          [user.id, user.username, globalName, user.avatar]
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

  try {
    if (redirect) {
      const url = new URL(redirect);
      const allowedDomains = ['cipher.uno', 'draft.cipher.uno', 'haya-pvp.vercel.app'];

      if (
        allowedDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      ) {
        (req.session as any).oauthRedirect = redirect;
      }
    }
  } catch (err) {
    console.warn("⚠️ Invalid redirect URL:", redirect);
  }

  passport.authenticate("discord")(req, res, next);
});


router.get(
  "/discord/callback",
  passport.authenticate("discord", { failureRedirect: process.env.FRONTEND_HOME_URL }),
  (req: Request, res: Response) => {
    const session = req.session as typeof req.session & { oauthRedirect?: string };
    const redirect = session.oauthRedirect;
    if (redirect) delete session.oauthRedirect;
    res.redirect(redirect || process.env.FRONTEND_HOME_URL!);
  }
);

router.get("/me", async (req: Request, res: Response): Promise<void> => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }

  const baseUser = req.user as DiscordUser;

  try {
    // Get avatar from DB if missing
    let avatar = baseUser.avatar;
    if (!avatar) {
      const avatarResult = await pool.query(
        `SELECT avatar FROM discord_usernames WHERE discord_id = $1`,
        [baseUser.id]
      );
      avatar = avatarResult.rows[0]?.avatar ?? null;
    }

    // Safe check for admin status
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
    res.json({ user: { ...baseUser } }); // fallback
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
