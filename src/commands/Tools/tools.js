/** Opt-in /tools group. Original slash modules remain available for prefix commands. */
import { createCompactCommandGroup } from '../../utils/compactCommandGroup.js';
import baseconvert from './baseconvert.js';
import calculate from './calculate.js';
import countdown from './countdown.js';
import embedbuilder from './embedbuilder.js';
import generatepassword from './generatepassword.js';
import hexcolor from './hexcolor.js';
import poll from './poll.js';
import randomuser from './randomuser.js';
import shorten from './shorten.js';
import time from './time.js';
import unixtime from './unixtime.js';

export default createCompactCommandGroup('tools', 'Useful server and everyday tools', 'Tools', {
  baseconvert, calculate, countdown, embedbuilder, generatepassword,
  hexcolor, poll, randomuser, shorten, time, unixtime,
});
