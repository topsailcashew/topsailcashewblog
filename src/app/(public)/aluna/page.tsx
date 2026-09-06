import type { Metadata } from "next";
import Link from "next/link";

/**
 * What Aluna is, for someone who has not signed up.
 *
 * The app opens on a sign-in form, so the only thing a stranger can learn from
 * it is that it wants their email address. Everything here comes from the
 * project's own README and privacy page — the numbers especially — because a
 * page that oversells the thing it links to is worse than no page at all.
 *
 * Static: nothing on it comes from the database, so there is nothing to
 * revalidate.
 */
export const revalidate = false;

const APP_URL = "https://aluna-2-0.vercel.app/";

const DESCRIPTION =
  "A private daily check-in for your body, your emotions and your mind. Eighty-two feelings, twenty-nine places to feel them, and encryption that means nobody else can read any of it.";

export const metadata: Metadata = {
  title: "Aluna",
  description: DESCRIPTION,
  alternates: { canonical: "/aluna" },
  openGraph: {
    title: "Aluna — notice, name, and track how you feel",
    description: DESCRIPTION,
    url: "/aluna",
    type: "website",
  },
};

const FIGURES = [
  { n: "82", of: "specific emotions", sub: "in seven families" },
  { n: "29", of: "places on the body", sub: "each with its own intensity" },
  { n: "4", of: "breathing patterns", sub: "sound made in the browser" },
] as const;

export default function AlunaPage() {
  return (
    /* No `id="content"` — the layout's <main> carries it, and a skip link
       needs exactly one target. */
    <div className="shell-wrap aluna">
      <header className="page-head">
        <p className="label">An app I built</p>
        <h1>Aluna</h1>
        <p>Notice, name, and track how you feel.</p>
      </header>

      <div className="aluna-lede">
        <p>
          Most mood trackers ask how you feel on a scale of one to five. Aluna
          asks <em>where</em> you feel it, <em>which</em> feeling it actually is
          out of eighty-two, and what your mind has been doing &mdash; then
          shows you what that adds up to over weeks.
        </p>
        <p>
          Every entry is encrypted on your device before it is sent. Nobody else
          can read your check-ins, including whoever runs the app.
        </p>
        <div className="aluna-actions">
          <a
            className="btn btn--primary"
            href={APP_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Aluna
          </a>
          <a
            className="btn"
            href={`${APP_URL}sign-up`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Create an account
          </a>
        </div>
      </div>

      <ul className="aluna-figures">
        {FIGURES.map((figure) => (
          <li key={figure.of}>
            <span className="aluna-figure-n">{figure.n}</span>
            <span className="aluna-figure-of">{figure.of}</span>
            <span className="aluna-figure-sub">{figure.sub}</span>
          </li>
        ))}
      </ul>

      <section className="aluna-section" aria-labelledby="checkin">
        <h2 className="label label--strong" id="checkin">
          Checking in
        </h2>
        <p>
          The quick path is the emotion wheel and a few optional context taps
          &mdash; under fifteen seconds once you know your way around. The full
          path adds a body scan, thought patterns and a guided reflection. Both
          write the same kind of entry, and skipping a step costs you nothing.
        </p>
        <p>
          The wheel goes seven families, then forty-one sub-categories, then
          eighty-two specific emotions: you start broad and narrow until it
          fits. You can pick as many as are true, including contradictory ones.
          Precision is the point &mdash; &ldquo;uneasy&rdquo; and
          &ldquo;dreading&rdquo; ask for different things, and working out which
          one it is tends to be more useful than any advice about it.
        </p>
        <p>
          The body map is twenty-nine locations on a figure you tap, each with
          an intensity and room for a note. Bodies often notice before minds do.
        </p>
      </section>

      <section className="aluna-section" aria-labelledby="after">
        <h2 className="label label--strong" id="after">
          What you get back
        </h2>
        <p>
          Saving a check-in offers a short piece of writing about what you
          logged &mdash; what that feeling tends to be like, and three ordinary
          things that can help. Pleasant feelings get noticing rather than
          fixing; nothing here treats a good day as a problem to manage.
        </p>
        <p className="aluna-claim">
          That writing is fixed text, written in advance and reviewed. It is not
          generated, and that is a privacy decision before it is an editorial
          one.
        </p>
        <p>
          Sending your emotional state to a third party on every check-in is
          exactly what the encryption exists to prevent. An API would have made
          the promise on the sign-up screen a lie the moment it shipped. Fixed
          text also means every sentence can be read before someone in a bad
          state reads it, which matters where a confidently wrong line lands
          hard.
        </p>
      </section>

      <section className="aluna-section" aria-labelledby="patterns">
        <h2 className="label label--strong" id="patterns">
          What it adds up to
        </h2>
        <p>
          A mood trend, the distribution of your feelings, a twenty-week grid,
          and plain-language observations about what your feelings travel with.
          History is a month calendar coloured by the dominant feeling, and the
          home screen takes the colour of whatever today has been.
        </p>
        <p>
          Observations only appear once there is enough to draw on &mdash; ten
          entries overall, four either side of any comparison, and a real gap
          between them. A pattern found in four check-ins is noise, and saying
          it confidently would be worse than saying nothing.
        </p>
      </section>

      <section className="aluna-section" aria-labelledby="quiet">
        <h2 className="label label--strong" id="quiet">
          Or don&rsquo;t, for a while
        </h2>
        <p>
          There is no streak to protect and no notification that can interrupt
          you. The calendar shows the gaps honestly rather than smoothing them
          over. Missing a week costs you nothing.
        </p>
        <p>
          There is also a journal &mdash; a blank page, separate from
          check-ins, encrypted the same way, with no prompts and no length
          anyone expects of you. And four guided breathing patterns, whose
          sound is synthesised in the browser rather than shipped as audio
          files.
        </p>
      </section>

      <section className="aluna-section aluna-privacy" aria-labelledby="privacy">
        <h2 className="label label--strong" id="privacy">
          Nobody else can read it
        </h2>
        <p className="aluna-claim">
          Entry content is encrypted in your browser with a key derived from
          your password. The key never reaches the server.
        </p>
        <p>
          A random data key does the encrypting, and is stored only as two
          wrapped copies: one sealed by your password, one by a twelve-word
          recovery phrase shown once at sign-up. Changing your password re-wraps
          the key, instantly, however many entries exist.
        </p>
        <p>
          Losing both the password and the phrase makes every entry permanently
          unreadable, by anyone. There is no reset and no backup. That is the
          trade, and it is the honest one: nobody can read your entries, which
          is the same fact as nobody can recover them.
        </p>
        <p>
          What is <em>not</em> encrypted, because the app cannot work otherwise:
          your email, display name, avatar, timestamps, preferences, and
          anything you deliberately post to Community. The{" "}
          <a href={`${APP_URL}privacy`} target="_blank" rel="noopener noreferrer">
            privacy page
          </a>{" "}
          says so plainly rather than implying everything is covered.
        </p>
      </section>

      <div className="notice aluna-disclaimer">
        <p>
          Aluna is a notebook for noticing how you feel. It does not diagnose
          anything and is not a substitute for a doctor, a therapist or a crisis
          line. Support numbers are listed under Help in the app.
        </p>
      </div>

      <div className="aluna-foot">
        <a
          className="btn btn--primary"
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open Aluna
        </a>
        <Link href="/articles">Read the writing instead &rarr;</Link>
      </div>
    </div>
  );
}
