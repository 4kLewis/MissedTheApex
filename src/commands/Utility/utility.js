/** Opt-in /utility group. Report, todo and wipedata remain separate. */
import { createCompactCommandGroup } from '../../utils/compactCommandGroup.js';
import avatar from './avatar.js';
import firstmsg from './firstmsg.js';
import serverinfo from './serverinfo.js';
import userinfo from './userinfo.js';
import weather from './weather.js';

export default createCompactCommandGroup('utility', 'Member and server information', 'Utility', {
  avatar, firstmsg, serverinfo, userinfo, weather,
});
