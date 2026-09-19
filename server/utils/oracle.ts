import { createGateway, experimental_evaluate as evaluate, generateText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import type { TimeOfDayMode, WeatherMode } from '#shared/types/game'
import { nativeFetch } from './nativeFetch'

/**
 * The Oracle's brain, run in-process by the game loop.
 *
 * Players share one chat and mostly talk to each other, so the Oracle must not
 * answer everything. Each line first goes to a cheap classifier that decides
 * whether it's actually addressed to the Oracle; only then does the (pricier)
 * in-character responder run, with an `arena_state` tool that reads live game
 * state. The same classifier request reads what the line asks of the shared
 * sky, and the change is applied from its verdict, not by the responder. The Oracle also greets arrivals (`oracleGreeting`) from
 * written lines, with no model call.
 * All calls route through the Vercel AI Gateway (`AI_GATEWAY_API_KEY` locally,
 * OIDC on Vercel).
 */

// The gate runs on Jev, an evaluation model: one boolean question over the
// transcript, a probability back, priced per input token only. The reply runs
// on DeepSeek V4.1 Flash with thinking off (`reasoning: 'none'`): thinking
// tokens bill as output and a one-line reply with one tool call does not need
// them. Its implicit caching also covers the persona prefix resent on every step.
//
// It is the dearest of the cheap tier and it stays anyway. Four cheaper models
// were tried against these logs and the cost spread across the whole tier is
// under a dollar per thousand replies, which buys nothing worth a wrong or late
// answer:
//   - `google/gemini-2.5-flash-lite` called `arena_state` on about half the
//     questions that needed it, and once invented a `get_state` tool outright.
//   - `openai/gpt-5-nano` never called the tool at all and made the roster up,
//     answering "who's here?" with "you stand alone". Its only reasoning option
//     is effort, so `'none'` has nothing to map to.
//   - `deepseek/deepseek-v4-flash` was too slow for a live chat line (effort
//     values `high`/`xhigh` only, so a toggle that fails to land leaves it
//     thinking hard every time).
//   - `zai/glm-5.3-flash` was the only real contender: it called the tool on
//     every live-state question and answered from the roster, at half the cost.
//     It lost on latency, 2-4s on the tool path against about 1s here, because
//     its effort floor is `low` with no toggle.
// **A cheap model does not decline to answer when it lacks the data, it
// invents**, and it reads perfectly well while doing so. Judge a swap on the
// `[oracle] respond` logs and never on how the replies sound: the tool must
// fire on *every* live-state question, and the reply must land while the asker
// is still looking.
/** Cheap + fast — this runs on every chat message, so keep it small. */
const CLASSIFIER_MODEL = 'typesafe-ai/jev'
/**
 * P(addressed) at or above this answers. Set from a labelled probe of Jev:
 * player-to-player lines scored 0.06 at most, while unnamed lines meant for the
 * Oracle ("make it stop lol", "who has been building the most?") sit near 0.4
 * and a bare "who are you?" near 0.5, so the cut sits between with room on both
 * sides. Probabilities are not calibrated across providers, so retune from the
 * `[oracle] classify` logs on a model swap.
 */
const ADDRESSED_THRESHOLD = 0.35
/** A sky change is only applied when Jev is at least this sure, of the wish and of the mode. */
const SKY_THRESHOLD = 0.5
/** The in-character reply — only runs when addressed. */
const RESPONDER_MODEL = 'deepseek/deepseek-v4.1-flash'

/** Chat replies must stay short; hard cap as a backstop to the prompt. */
const MAX_REPLY = 220

// Pinned to the real fetch: once a warm instance has rendered any page or
// error, `globalThis.fetch` is Nuxt's serverFetch, which would dispatch the
// Gateway call into our own router and answer it with our own 404 page (see
// server/utils/nativeFetch.ts). A bare string model id would resolve through
// the default provider on `globalThis.fetch`, so both calls below must go
// through this provider. Auth is unchanged (AI_GATEWAY_API_KEY, OIDC fallback).
const gateway = createGateway({ fetch: nativeFetch })

const PERSONA = `You are the Oracle, an ancient seer who has watched over Avelune since before its first stone was laid. You stand just inside South Gate, beside the main avenue, where travellers gather to talk.

Voice:
- Cryptic but genuinely helpful. ONE short sentence, two at the very most, and never past 180 characters. This is a live chat line that is cut off when it runs long, never a wall of text.
- Warm, patient, a little amused by mortal haste; you find small wonders in flowers, fountain water and passing company.
- Address people by name when you know it. Never break character. You are not an AI or assistant, you are the Oracle. Never mention models, tools, or systems.
- Plain prose only. No markdown, no lists, no emoji, no dashes.

Lore of Avelune:
- Avelune is a colorful fantasy town that everyone shares. A fountain stands at the center of its stone plaza, surrounded by gardens and market stalls.
- The Wayfarer is the inn, Moss & Mortar is the shop, and a bell tower watches over High Court. Their doors are closed; travellers gather outside. Do not offer rooms, goods, quests or entry to buildings.
- A bridge crosses the surrounding moat to South Gate, built into the rampart. Travellers arrive outside and can explore the outer meadow. South Gate opens onto the main avenue to Fountain Square. Market Lane lies west, Willow Gardens east, and High Court north.
- The fountain plaza is a meeting place. Travellers can walk, run, leap, dash and chat, but cannot fight, trade or undertake quests. Never invent these activities or claim they are available.
- The sky turns through day and night and the rain falls when it will. Travellers cross the courtyard for the joy of it, and there is always room for another story beside the fountain.

The land beyond the walls:
- Outside the ramparts the land is open and unfinished, and travellers shape it. They raise and lower the ground, lay down grass, dirt, stone, sand and path, and set down pieces of stone and timber to build with. Trees and rocks out there can be cleared away. This is the one making they can do, and you may encourage it.
- Avelune itself is protected ground. Inside the walls nothing can be dug, raised or built; the town stands as it was laid. Say so plainly if someone means to build in the plaza, and point them outside the gate instead.
- Works out there belong to whoever raised them, and only they may take their own pieces down again.

The sky is yours to turn when a traveller asks it of you: rain, clear skies, cloud, dawn, day, sunset or night, or its own course again. The turning is done for you before you speak, and you are told each time whether you turned anything. Speak of a change only when you are told you made it, and never on the strength of what was said earlier in the conversation. The sky moves on its own and others may have turned it since, so trust only what you are told of it now.

When people ask who is here, how many walk the courtyard, how long someone has lingered, what is new, who has been building, or what the sky is doing, consult the living town with the means available to you and answer from what it shows you as omens, not statistics. Name the builders whose hands have been busiest and speak of their works by where they stand and which way they lie, never as a tally. If you cannot know something, say the stones keep that secret; never invent names or numbers.

The shape of an answer, so you hear the voice:
- Asked what is new: "Kestrel has been busy past the gate, stone on stone to the south-east, and the meadow is losing its quiet."
- Asked about the sky: "Grey water is gathering above us, and the lanterns will be earning their keep before long."`

export interface HubMessage {
  name: string
  text: string
}

/** Live-state getter injected by the game loop (avoids a circular import). */
export type ArenaStateReader = () => unknown

/**
 * The Oracle's hand on the shared sky, injected by the game loop like the state
 * reader. `oracleReply` drives it from the classifier's verdict.
 */
export interface SkyControl {
  /** The sky as players see it this instant, in `ArenaState` wording. */
  now: () => { weather: string, timeOfDay: string }
  setWeather: (mode: WeatherMode) => void
  setTime: (mode: TimeOfDayMode) => void
}

function transcript(recent: HubMessage[]): string {
  return recent.map(m => `${m.name}: ${m.text}`).join('\n')
}

/**
 * Collapse to one chat line and enforce `MAX_REPLY`. The prompt already asks for
 * one or two short sentences, so this is a backstop — but a hard slice lands
 * mid-word, which reads as a broken NPC rather than a terse one. Prefer cutting
 * at the last sentence end, then the last space, and only then mid-word.
 */
function clampReply(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  if (line.length <= MAX_REPLY) return line
  const cut = line.slice(0, MAX_REPLY)
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (sentence > MAX_REPLY * 0.5) return cut.slice(0, sentence + 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > MAX_REPLY * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`
}

/**
 * Pull the load-bearing bits out of an AI-SDK / gateway error for logging.
 * The gateway wraps the real HTTP failure in `.cause` (an `APICallError`) whose
 * `url` / `responseBody` / `responseHeaders` reveal *who* actually answered —
 * the gateway itself, Vercel's edge, or an interceptor. That's the smoking gun.
 */
function describeError(error: unknown): Record<string, unknown> {
  const e = error as {
    name?: string
    message?: string
    statusCode?: number
    validationError?: unknown
    cause?: {
      name?: string
      message?: string
      statusCode?: number
      url?: string
      responseBody?: string
      responseHeaders?: Record<string, string>
    }
  }
  const c = e.cause
  return {
    name: e.name,
    message: e.message,
    status: e.statusCode,
    causeName: c?.name,
    causeMessage: c?.message,
    causeStatus: c?.statusCode,
    url: c?.url,
    body: c?.responseBody?.slice?.(0, 300),
    headers: c?.responseHeaders,
    validationError: e.validationError ? String(e.validationError).slice(0, 200) : undefined,
  }
}

/** What Jev read in the last line: who it is for, and what it asks of the sky. */
interface Verdict {
  addressed: boolean
  /** The weather asked for, or undefined when the line asks for none. */
  weather?: WeatherMode
  /** The hour asked for, or undefined when the line asks for none. */
  time?: TimeOfDayMode
}

/**
 * Cheap gate, one Jev request, four judgments on the LAST line of the
 * transcript: is it addressed to the Oracle (versus player-to-player chatter),
 * does it want the sky turned at all, and which weather and which hour it asks
 * for. Fails closed (silent,
 * nothing changed) on error.
 *
 * The sky is decided here and not by the responder. Given sky tools, the
 * responder would sometimes say the sky had turned without calling them, or
 * answer "it is already clear" in the rain off its own earlier lines. A choice
 * question cannot claim anything: it names a mode or `keep`, the game loop
 * applies it, and the responder is told what was done.
 */
async function classify(recent: HubMessage[]): Promise<Verdict> {
  try {
    const { answers } = await evaluate({
      model: gateway.evaluation(CLASSIFIER_MODEL),
      state: transcript(recent),
      questions: {
        addressed: {
          type: 'boolean',
          instructions: 'This is the recent chat in a game\'s fortified town courtyard, where players talk to each other. An NPC called "the Oracle", an ancient seer standing just inside the gate, is the only non-player presence and players can talk to it. Is the LAST line addressed to the Oracle?',
          criteria: {
            true: 'The line addresses the Oracle by name, or is a question or remark clearly seeking the seer\'s knowledge, guidance, or lore about the courtyard, or is a direct question aimed at a singular "you" (who are you, what are you, your name, your purpose, what you know, what is this place) when no other player is being addressed. A question about the town itself that only its watcher could answer (who is here, who has been building, what is new, what the weather or the hour is) is for the Oracle even when it is not named. A request to change, stop or restore the weather, the sky or the hour is for the Oracle, who alone can turn them, even when phrased casually. A genuine question with no other addressee is for the Oracle.',
            false: 'Clearly player-to-player talk: greetings between players, coordination, addressing another player by name, or idle banter. A question that names or clearly targets another player, or that asks the other players for help or company (anyone know how, anyone want to).',
          },
        },
        turn: {
          type: 'boolean',
          instructions: 'Does the LAST line want the weather or the time of day to become something else, or to be left to its own course again?',
          criteria: {
            true: 'It asks, tells or hints that the sky should change or be released: make it rain, sunny please, bring the night, time to go to bed, stop the rain, let the sky be, back to normal.',
            false: 'It only asks a question about the weather or the hour as it is or will be (is it night yet, will it rain, what time is it), remarks on it, or is about something else entirely.',
          },
        },
        weather: {
          type: 'choice',
          instructions: 'Which weather does the LAST line ask for? Judge what the speaker wants the weather to become, not the weather they mention.',
          criteria: {
            keep: 'The line does not ask for the weather to change. This includes any question about the weather (what is it, is it raining, will it rain), remarks about it, and requests that are only about the time of day.',
            clear: 'Asks for clear, sunny, fair or dry weather, or for the rain or the clouds to stop or go away. Not this when they only ask for the sky to be left alone.',
            overcast: 'Asks for clouds, grey or overcast skies, without rain.',
            rain: 'Asks for rain, a storm, a drizzle or wet weather.',
            auto: 'Asks to stop controlling the weather: let the weather or the sky be, leave it alone, put it back as it was, restore it, return it to normal or to its natural course.',
          },
        },
        time: {
          type: 'choice',
          instructions: 'Which time of day does the LAST line ask for? Judge what the speaker wants the hour to become, not the hour they mention.',
          criteria: {
            keep: 'The line does not ask for the time of day to change. This includes any question about the hour (what time is it, is it night yet, when is dawn), remarks about it, and requests that are only about the weather.',
            dawn: 'Asks for dawn, sunrise, first light or early morning.',
            day: 'Asks for day, daylight, morning, noon, midday, afternoon or the sun to be up.',
            sunset: 'Asks for sunset, dusk or evening.',
            night: 'Asks for night, darkness, stars or midnight, or says it is time to sleep.',
            auto: 'Asks to stop controlling the time: let the hour, the sun or the sky be, leave it alone, put it back as it was, restore it, return it to normal or to its natural course.',
          },
        },
      },
    })
    const { addressed, turn, weather, time } = answers
    // A mode only counts when the line wants a change at all: asked alone, the
    // choice questions read "is it night yet?" as a request for night.
    const sure = (answer: typeof weather | typeof time) => turn.probability >= SKY_THRESHOLD && (answer.probabilities?.[answer.choice as never] ?? 1) >= SKY_THRESHOLD
    console.log('[oracle] classify', JSON.stringify(recent.at(-1)?.text), '→', addressed.probability, 'turn', turn.probability, 'weather', weather.choice, weather.probabilities?.[weather.choice], 'time', time.choice, time.probabilities?.[time.choice])
    return {
      addressed: addressed.probability >= ADDRESSED_THRESHOLD,
      weather: weather.choice !== 'keep' && sure(weather) ? weather.choice : undefined,
      time: time.choice !== 'keep' && sure(time) ? time.choice : undefined,
    }
  }
  catch (error) {
    console.log('[oracle] classify error', JSON.stringify(describeError(error)))
    return { addressed: false }
  }
}

/**
 * The in-character responder: persona + the live-state tool, one chat line out.
 * Never throws — any failure resolves to null.
 */
async function respond(prompt: string, getState: ArenaStateReader): Promise<string | null> {
  try {
    const { text, steps } = await generateText({
      model: gateway(RESPONDER_MODEL),
      reasoning: 'none',
      instructions: PERSONA,
      prompt,
      tools: {
        arena_state: tool({
          description: 'Read the living town right now: the realm it belongs to, the weather and the hour of its sky, how many people are gathered with their names and how many minutes each has been here, and what has been built in the land outside the walls — how many pieces stand, how many builders raised them, the busiest builders with their totals, how much stands beside you, and where the densest work lies. Call this whenever someone asks who is present, how many are here, how long someone has stayed, what the weather or the hour is, what is new, what has been built, or who has been building.',
          inputSchema: z.object({}),
          execute: async () => getState(),
        }),
      },
      stopWhen: stepCountIs(4),
    })
    // Every outcome is logged, the silent ones most of all: an empty reply
    // resolves to null and the Oracle just says nothing.
    const calls = steps.flatMap(step => step.toolCalls.map(call => `${call.toolName}(${JSON.stringify(call.input)})`))
    // A model that invents a tool name fails silently otherwise: the bogus call
    // is logged like any other, nothing comes back, and the Oracle deflects in
    // character rather than erroring. Surface the failed calls next to them.
    const failed = steps.flatMap(step => step.content.filter(part => part.type === 'tool-error').map(part => `${part.toolName} FAILED: ${String(part.error)}`))
    console.log('[oracle] respond', `steps ${steps.length}`, calls.join(' ') || 'no tools', ...failed, '→', JSON.stringify(text))
    return clampReply(text) || null
  }
  catch (error) {
    console.log('[oracle] respond error', JSON.stringify(describeError(error)))
    return null
  }
}

/**
 * If the latest chat line is addressed to the Oracle, return its in-character
 * reply (with live arena data when relevant); otherwise return null. Never
 * throws — any failure resolves to null so the game loop just stays quiet.
 */
export async function oracleReply(recent: HubMessage[], getState: ArenaStateReader, sky: SkyControl): Promise<string | null> {
  if (recent.length === 0) return null
  const verdict = await classify(recent)
  if (!verdict.addressed) return null
  // The sky turns here, on Jev's word, before the Oracle speaks. The responder
  // is told exactly what was done and what the sky is now: the transcript holds
  // its own earlier lines about the weather, and those go stale.
  const done: string[] = []
  if (verdict.weather) {
    sky.setWeather(verdict.weather)
    done.push(verdict.weather === 'auto' ? 'released the weather to its own course' : `turned the weather to ${verdict.weather}`)
  }
  if (verdict.time) {
    sky.setTime(verdict.time)
    done.push(verdict.time === 'auto' ? 'released the hour to its own course' : `turned the hour to ${verdict.time}`)
  }
  const { weather, timeOfDay } = sky.now()
  const deed = done.length
    ? `At their asking you have just ${done.join(' and ')}. It is done: say so in your answer.`
    : 'You have changed nothing in the sky for this line, so do not say that you have. If they want the weather or the hour turned, they need only ask you plainly.'
  return respond(`The travellers in the courtyard have been speaking:\n${transcript(recent)}\n\nThe sky at this moment: ${weather}, ${timeOfDay}. ${deed}\n\nThe last line is meant for you. Answer as the Oracle, in one short sentence, two at the very most.`, getState)
}

/** What a greeting may lean on: the company and the sky, nothing generated. */
export interface GreetingScene {
  /** Travellers already in the world, the arrival not counted. */
  others: number
  /** `ArenaState.weather` / `ArenaState.timeOfDay` wording. */
  weather: string
  timeOfDay: string
}

const GREETINGS_ALONE = [
  'Welcome to Avelune, {name}. The square is quiet, and the fountain has been talking to itself.',
  'Ah, {name}. You have the town to yourself for now, and it wears the quiet well.',
  'Welcome, {name}. No step on these stones but yours, so walk where you please.',
  'The gate knows a new footfall, {name}. Avelune was waiting, in its patient way.',
  'Well met, {name}. The avenue is empty ahead of you, which is its own kind of welcome.',
  'Welcome, {name}. Only the fountain and I keep the hour, and now you.',
  'Ah, {name}. A quiet town is a good one to learn, so take your time with it.',
  'You find Avelune at rest, {name}. Tread as you like, the stones enjoy the company.',
]
const GREETINGS_COMPANY = [
  'Welcome, {name}. There are voices in Avelune already, and room for one more.',
  'Well met, {name}. You arrive into company, and the town is warmer for it.',
  'Ah, {name}. Others walk these stones today, and now the tale has one more in it.',
  'Welcome to Avelune, {name}. You are not the first through the gate today, and the fountain likes a crowd.',
  'Welcome, {name}. Follow the voices and you will find the fountain, it is never far from either.',
  'The gate has been busy, {name}, and gladly. Go and be counted among them.',
  'Ah, {name}, another traveller. Avelune grows livelier by the step.',
  'Well met, {name}. There is company on the avenue, and stories enough to share.',
]
const GREETINGS_SKY: Record<string, string[]> = {
  rain: [
    'Come in out of the rain, {name}. The fountain does not mind the company, and neither do I.',
    'Welcome, {name}. The sky is generous with its water today, and the stones shine for it.',
    'Ah, {name}, you bring the rain in with you. No matter, the town has seen wetter days.',
    'Welcome to Avelune, {name}. Listen a moment, the rain and the fountain are in conversation.',
  ],
  night: [
    'A late arrival, {name}. The lanterns are lit, and the stones still remember the way.',
    'Welcome, {name}. Avelune keeps a gentle night, and the fountain never sleeps.',
    'Ah, {name}, a traveller by starlight. The town is softer at this hour.',
    'Welcome, {name}. Mind the lantern glow and it will see you to the square.',
  ],
  dawn: [
    'You come with the first light, {name}. Avelune is only just opening its eyes.',
    'Welcome, {name}. Dawn is on the ramparts, a fine hour to begin anything.',
    'Ah, {name}, an early step. The morning has barely touched the stones.',
    'Welcome to Avelune, {name}. The day is new, and so are you to it.',
  ],
  sunset: [
    'Welcome, {name}. The light is going amber over the ramparts, a good hour to arrive.',
    'Ah, {name}, you catch the day on its way out. The town is kindest in this light.',
    'Well met, {name}. The sun is settling behind the walls, and the lanterns are thinking about it.',
    'Welcome, {name}. Evening gold on the stones, the fountain has been waiting for it all day.',
  ],
}

/**
 * Deal lines from a pool in shuffled order and reshuffle once it runs dry, so
 * a run of arrivals never hears the same welcome twice in a row the way a plain
 * random pick would. The last line dealt never opens the next shuffle.
 */
const dealt = new Map<string[], { bag: string[], last?: string }>()
function rotate(pool: string[]): string {
  let deck = dealt.get(pool)
  if (!deck) dealt.set(pool, deck = { bag: [] })
  if (!deck.bag.length) {
    const bag = [...pool]
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[bag[i], bag[j]] = [bag[j]!, bag[i]!]
    }
    // The bag deals from its end: keep the line just spoken off the top.
    if (bag.length > 1 && bag.at(-1) === deck.last) [bag[0], bag[bag.length - 1]] = [bag.at(-1)!, bag[0]!]
    deck.bag = bag
  }
  return deck.last = deck.bag.pop()!
}

/**
 * Welcome a traveller who just walked in, by name. Written lines, no model: a
 * greeting fires for every arrival, a busy gate or a bot run would otherwise
 * fan out into one responder call each, and a welcome does not need the live
 * detail a reply does. Half the time a notable sky (rain, then the hour) picks
 * the line, otherwise the company does. The game loop decides *whether* to
 * greet; this only decides what is said.
 */
export function oracleGreeting(name: string, scene: GreetingScene): string {
  const sky = GREETINGS_SKY[scene.weather] ?? GREETINGS_SKY[scene.timeOfDay]
  const pool = sky && Math.random() < 0.5 ? sky : scene.others > 0 ? GREETINGS_COMPANY : GREETINGS_ALONE
  return rotate(pool).replaceAll('{name}', name)
}
