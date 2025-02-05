/**
 * This tool initializes IRC channels that will be used for breakout sessions.
 *
 * To run the tool:
 *
 *  node tools/setup-irc.mjs [slot or "all"] [sessionNumber or "all"] [commands] [dismiss]
 *
 * where [slot or "all"] is the slot start time of sessions to initialize
 * (e.g. "9:30"), or "all" to initialize sessions across slots. The job is
 * intended to be run shortly before each slot to init RRSAgent and Zakim. The
 * "all" choice is probably not a good idea unless you also specify a session
 * number: IRC bots leave channels after 2 hours of inactivity!
 * 
 * [sessionNumber or "all"] is the session issue number or "all" to initialize
 * IRC channels for all valid sessions in the slot.
 * 
 * Set [commands] to "commands" to only output the IRC commands to run without
 * actually running them.
 * 
 * Set [dismiss] to "dismiss" to make bots draft minutes and leave the channel.
 */

import { getEnvKey } from './lib/envkeys.mjs';
import { fetchProject } from './lib/project.mjs'
import { validateSession } from './lib/validate.mjs';
import { todoStrings } from './lib/todostrings.mjs';
import irc from 'irc';

const botName = 'tpac-breakout-bot';

/**
 * Helper function to generate a shortname from the session's title
 */
function getChannel(session) {
  return session.description.shortname;
}

async function main({ number, slot, onlyCommands, dismissBots } = {}) {
  const PROJECT_OWNER = await getEnvKey('PROJECT_OWNER');
  const PROJECT_NUMBER = await getEnvKey('PROJECT_NUMBER');
  const CHAIR_W3CID = await getEnvKey('CHAIR_W3CID', {}, true);
  console.log();
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER}...`);
  const project = await fetchProject(PROJECT_OWNER, PROJECT_NUMBER);
  if (!project) {
    throw new Error(`Project ${PROJECT_OWNER}/${PROJECT_NUMBER} could not be retrieved`);
  }
  project.chairsToW3CID = CHAIR_W3CID;
  let sessions = project.sessions.filter(s => s.slot &&
    (!number || s.number === number) &&
    (!slot || s.slot.startsWith(slot)));
  sessions.sort((s1, s2) => s1.number - s2.number);
  if (number) {
    if (sessions.length === 0) {
      throw new Error(`Session ${number} not found in project ${PROJECT_OWNER}/${PROJECT_NUMBER} or not assigned to requested slot`);
    }
    else if (!sessions[0].slot) {
      throw new Error(`Session ${number} not assigned to a slot in project ${PROJECT_OWNER}/${PROJECT_NUMBER}`);
    }
  }
  else if (slot) {
    console.log(`- found ${sessions.length} sessions assigned to slot ${slot}: ${sessions.map(s => s.number).join(', ')}`);
  }
  else {
    console.log(`- found ${sessions.length} sessions assigned to slots: ${sessions.map(s => s.number).join(', ')}`);
  }
  sessions = await Promise.all(sessions.map(async session => {
    const sessionErrors = (await validateSession(session.number, project))
      .filter(error => error.severity === 'error');
    if (sessionErrors.length > 0) {
      return null;
    }
    return session;
  }));
  sessions = sessions.filter(s => !!s);
  if (number) {
    if (sessions.length === 0) {
      throw new Error(`Session ${number} contains errors that need fixing`);
    }
  }
  else {
    console.log(`- found ${sessions.length} valid sessions among them: ${sessions.map(s => s.number).join(', ')}`);
  }
  console.log(`Retrieve project ${PROJECT_OWNER}/${PROJECT_NUMBER} and session(s)... done`);

  console.log('Compute IRC channels...');
  const channels = {};
  for (const session of sessions) {
    const channel = getChannel(session);
    if (!channels[channel]) {
      channels[channel] = [];
    }
    channels[channel].push(session);
    channels[channel].sort((s1, s2) => {
      const slot1 = project.slots.findIndex(slot => slot.name === s1.slot);
      const slot2 = project.slots.findIndex(slot => slot.name === s2.slot);
      return slot1 - slot2;
    });
  }
  sessions = Object.values(channels).map(sessions => sessions[0]);
  console.log(`- found ${Object.keys(channels).length} different IRC channels`);
  console.log('Compute IRC channels... done');

  console.log();
  console.log('Connect to W3C IRC server...');
  const bot = onlyCommands ?
    undefined :
    new irc.Client('irc.w3.org', botName, {
      channels: []
    });

  function joinChannel(session) {
    const channel = getChannel(session);
    console.log(`/join ${channel}`);
    if (!onlyCommands) {
      bot.join(channel);
    }
  }

  function inviteBot(session, name) {
    const channel = getChannel(session);
    console.log(`/invite ${name} ${channel}`);
    if (!onlyCommands) {
      bot.send('INVITE', name, channel);
    }
  }

  function setTopic(session) {
    const channel = getChannel(session);
    const room = project.rooms.find(r => r.name === session.room);
    const roomLabel = room ? `- ${room.label} ` : '';
    const topic = `TPAC breakout: ${session.title} ${roomLabel}- ${session.slot}`;
    console.log(`/topic ${channel} ${topic}`);
    if (!onlyCommands) {
      bot.send('TOPIC', channel, topic);
    }
  }

  function say(channel, msg) {
    console.log(`/msg ${channel} ${msg}`);
    if (!onlyCommands) {
      bot.say(channel, msg);
    }
  }

  function sendChannelBotCommands(channel, nick) {
    const session = sessions.find(s => channel === getChannel(s));
    if (!session) {
      return;
    }
    const room = project.rooms.find(r => r.name === session.room);
    const roomLabel = room ? `- ${room.label} ` : '';
    if (nick === botName) {
      if (dismissBots) {
        say(channel, `RRSAgent, draft minutes`);
        say(channel, `RRSAgent, bye`);
        say(channel, `Zakim, bye`);
        if (bot) {
          bot.part(channel);
        }
      }
      else {
        setTopic(session);
        inviteBot(session, 'Zakim');
        inviteBot(session, 'RRSAgent');
      }
    }
    else if (nick === 'RRSAgent') {
      say(channel, `RRSAgent, do not leave`);
      say(channel, `RRSAgent, make logs ${session.description.attendance === 'restricted' ? 'member' : 'public'}`);
      say(channel, `Meeting: ${session.title}`);
      say(channel, `Chair: ${session.chairs.map(c => c.name).join(', ')}`);
      if (session.description.materials.agenda &&
          !todoStrings.includes(session.description.materials.agenda)) {
        say(channel, `Agenda: ${session.description.materials.agenda}`);
      }
      else {
        say(channel, `Agenda: https://github.com/${session.repository}/issues/${session.number}`);
      }
      if (session.description.materials.slides &&
          !todoStrings.includes(session.description.materials.slides)) {
        say(channel, `Slideset: ${session.description.materials.slides}`);
      }
      say(channel, 'clear agenda');
      say(channel, 'agenda+ Pick a scribe');
      say(channel, 'agenda+ Reminders: code of conduct, health policies, recorded session policy');
      say(channel, 'agenda+ Goal of this session');
      say(channel, 'agenda+ Discussion');
      say(channel, 'agenda+ Next steps / where discussion continues');
      if (bot) {
        bot.part(channel);
      }
    }
    else if (nick === 'Zakim') {
      // No specific command to send when Zakim joins
    }
  }

  if (onlyCommands) {
    for (const session of sessions) {
      console.log();
      console.log(`session ${session.number}`);
      console.log('-----');
      joinChannel(session);
      sendChannelBotCommands(getChannel(session), botName);
      if (!dismissBots) {
        sendChannelBotCommands(getChannel(session), 'RRSAgent');
      }
      console.log('-----');
    }
    return;
  }

  bot.addListener('registered', msg => {
    console.log(`- Received message: ${msg.command}`);
    console.log('Connect to W3C IRC server... done');
    for (const session of sessions) {
      console.log();
      console.log(`session ${session.number}`);
      console.log('-----');
      joinChannel(session);
    }
  });

  bot.addListener('raw', msg => {
    //console.log(JSON.stringify(msg, null, 2));
  });

  bot.addListener('error', err => {
    if (err.command === 'err_useronchannel') {
      // We invited bots but they're already there, that's good!
      const nick = err.args[1];
      const channel = err.args[2];
      sendChannelBotCommands(channel, nick);
      return;
    }
    throw err;
  });

  bot.addListener('join', (channel, nick, message) => {
    sendChannelBotCommands(channel, nick);
  });

  bot.addListener('part', (channel, nick) => {
    if (nick !== botName) {
      return;
    }
    const session = sessions.find(s => channel === getChannel(s));
    if (!session) {
      return;
    }
    session.done = true;
    console.log('-----');
    if (sessions.every(s => s.done)) {
      bot.disconnect(_ => promiseResolve());
    }
  });

  let promiseResolve;
  return new Promise(resolve => promiseResolve = resolve);
}


// Read slot from command-line
if (!process.argv[2] || !process.argv[2].match(/^(\d{1,2}:\d{2}|all)$/)) {
  console.log('Command needs to receive a valid slot start time (e.g., 9:30) or "all" as first parameter');
  process.exit(1);
}

// Read session number from command-line
if (!process.argv[3] || !process.argv[3].match(/^(\d+|all)$/)) {
  console.log('Command needs to receive a session number (e.g., 15) or "all" as second parameter');
  process.exit(1);
}

// Command only?
const onlyCommands = process.argv[4] === 'commands';
const dismissBots = process.argv[5] === 'dismiss';


const slot = process.argv[2] === 'all' ? undefined : process.argv[2];
const number = process.argv[3] === 'all' ? undefined : parseInt(process.argv[3], 10);

main({ slot, number, onlyCommands, dismissBots })
  .then(_ => process.exit(0))
  .catch(err => {
    console.log(`Something went wrong: ${err.message}`);
    throw err;
  });