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
            `INSERT INTO players (
                discord_id, nickname, avatar,
                elo, games_played, win_rate,
                uid, mirror_id, points,
                description, color, banner_url
            ) VALUES (
                $1, $2, $3,
                200, 0, 0.0,
                'Not Registered', 'Not Set', 0,
                'A glimpse into this soul’s gentle journey…', 11658748, NULL
            )
            ON CONFLICT (discord_id) DO UPDATE
            SET nickname = EXCLUDED.nickname,
                avatar   = EXCLUDED.avatar`,
            [user.id, user.username, user.avatar]
            );
      } catch (err) {
        console.error("Failed to save user to DB:", err);
      }

      return done(null, user);
    }
  )
);

/* ───── Routes ───── */

router.get("/discord", passport.authenticate("discord"));

router.get(
  "/discord/callback",
  passport.authenticate("discord", { failureRedirect: process.env.FRONTEND_HOME_URL }),
  (_req: Request, res: Response) => {
    res.redirect(process.env.FRONTEND_HOME_URL as string);
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
      `SELECT avatar FROM players WHERE discord_id = $1`,
      [baseUser.id]
    );
    const avatar = result.rows[0]?.avatar ?? null;
    res.json({ user: { ...baseUser, avatar } });
  } catch (err) {
    console.error("Error fetching avatar from DB:", err);
    res.json({ user: baseUser });
  }
});

export { router as discordAuthRouter };
