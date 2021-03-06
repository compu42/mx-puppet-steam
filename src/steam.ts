import {
	IFileEvent,
	IMessageEvent,
	IReceiveParams,
	IRemoteRoom,
	IRemoteUser,
	Log,
	PuppetBridge,
	Util,
} from "mx-puppet-bridge";
import * as SteamUser from "steam-user";
import * as SteamCommunity from "steamcommunity";
import * as SteamID from "steamid";
import {EPersonaState} from "./enum";
import {MatrixPresence} from "mx-puppet-bridge/lib/src/presencehandler";
import {
	AppInfo,
	IGroupDetails,
	IGroupInfo,
	IIncomingChatMessage,
	IIncomingFriendMessage,
	IPersona,
	isBBCode
} from "./interfaces";
import {IRetList} from "mx-puppet-bridge/src/interfaces";
import {IRemoteGroup} from "mx-puppet-bridge/lib/src";

const log = new Log("MatrixPuppet:Steam");

interface ISteamPuppet {
	client: SteamUser;
	community: SteamCommunity;
	data: any;
	sentEventIds: string[];
	knownPersonas: Map<string, IPersona>,
	knownApps: Map<string, AppInfo>,
	ourSendImages: string[],
}

interface ISteamPuppets {
	[puppetId: number]: ISteamPuppet;
}

interface IPuppetParams {
	accountName: string,
	loginKey: string,

	[key: string]: string;
}

export class Steam {
	private puppets: ISteamPuppets = {};

	constructor(
		private bridge: PuppetBridge,
	) {

	}

	async getPersona(p: ISteamPuppet, steamid: SteamID): Promise<IPersona> {
		let steamIdString = steamid.toString();
		let persona = p.knownPersonas.get(steamIdString);
		if (persona) {
			return persona;
		} else if (p.client.users[steamIdString]) {
			return p.client.users[steamIdString];
		} else {
			let {personas} = await p.client.getPersonas([steamid]);
			let persona = personas[steamIdString];
			p.knownPersonas.set(steamIdString, persona);
			return persona;
		}
	}

	async getProduct(p: ISteamPuppet, appId: string): Promise<AppInfo> {
		let app = p.knownApps.get(appId);
		if (app) {
			return app;
		} else {
			let {apps} = await p.client.getProductInfo([parseInt(appId, 10)], []);
			let app = apps[appId];
			p.knownApps.set(appId, app);
			return app;
		}
	}

	public async getFriendMessageSendParams(puppetId: number, msg: IIncomingFriendMessage, fromSteamId?: SteamID): Promise<IReceiveParams> {
		const p = this.puppets[puppetId];

		let persona = await this.getPersona(p, fromSteamId ? fromSteamId : msg.steamid_friend);

		return {
			room: {
				puppetId,
				roomId: msg.steamid_friend.toString(),
				isDirect: true,
			},
			user: {
				puppetId,
				userId: fromSteamId ? fromSteamId.toString() : msg.steamid_friend.toString(),
				name: persona.player_name,
				avatarUrl: persona.avatar_url_medium
			},
			eventId: `${msg.server_timestamp.toISOString()}::${msg.ordinal}`,
		} as IReceiveParams;
	}

	public async getChatMessageSendParams(puppetId: number, msg: IIncomingChatMessage, fromSteamId?: SteamID): Promise<IReceiveParams> {
		const p = this.puppets[puppetId];

		let persona = await this.getPersona(p, fromSteamId ? fromSteamId : msg.steamid_sender);

		return {
			room: {
				puppetId,
				roomId: `chat_${msg.chat_group_id}_${msg.chat_id}`,
				isDirect: false,
				name: msg.chat_name,
			},
			user: {
				puppetId,
				userId: fromSteamId ? fromSteamId.toString() : msg.steamid_sender.toString(),
				name: persona.player_name,
				avatarUrl: persona.avatar_url_medium
			},
			eventId: `${msg.server_timestamp.toISOString()}::${msg.ordinal}`,
		} as IReceiveParams;
	}

	public parseChatRoomId(roomId: string): [string, string] {
		let matches = roomId.match(/chat_(\d+)_(\d+)/);
		if (matches) {
			return [matches[1], matches[2]];
		} else {
			throw new Error("invalid chatroom id");
		}
	}

	public async newPuppet(puppetId: number, data: IPuppetParams) {
		log.info(`Adding new Puppet: puppetId=${puppetId}`);
		if (this.puppets[puppetId]) {
			await this.deletePuppet(puppetId);
		}
		const client = new SteamUser();
		const community = new SteamCommunity();

		this.puppets[puppetId] = {
			client,
			community,
			data,
			sentEventIds: [],
			typingUsers: {},
			knownPersonas: new Map(),
			knownApps: new Map(),
			ourSendImages: [],
		} as ISteamPuppet;
		try {
			client.logOn({
				accountName: data.accountName,
				loginKey: data.loginKey,
				rememberPassword: true,
				logonID: puppetId,
			});

			client.on("user", async (steamId, persona: IPersona) => {
				const p = this.puppets[puppetId];
				p.knownPersonas.set(steamId.toString(), persona);

				let state: MatrixPresence = "offline";

				switch (persona.persona_state) {
					case EPersonaState.Away:
					case EPersonaState.Busy:
					case EPersonaState.Snooze:
						state = "unavailable";
						break;
					case EPersonaState.LookingToPlay:
					case EPersonaState.LookingToTrade:
					case EPersonaState.Online:
						state = "online";
						break;
				}

				if (steamId.toString() != client.steamID.toString()) {

					await this.bridge.setUserPresence({
						puppetId,
						userId: steamId.toString()
					}, state);

					if (persona.gameid && persona.gameid !== '0') {
						let app = await this.getProduct(p, persona.gameid);
						await this.bridge.setUserStatus({
							puppetId,
							userId: steamId.toString()
						}, `Now playing: ${app.appinfo.common.name}`);
					} else {
						await this.bridge.setUserStatus({
							puppetId,
							userId: steamId.toString()
						}, "");
					}
				}
			});

			client.on("loggedOn", async (details) => {
				await this.bridge.setUserId(puppetId, client.steamID.toString());

				await this.bridge.sendStatusMessage(puppetId, `connected as ${details.vanity_url}(${client.steamID.toString()})!`);

				client.setPersona(EPersonaState.Away);
			});

			client.on("webSession", async (sessionId, cookies) => {
				community.setCookies(cookies);
			});

			client.on("loginKey", (loginKey) => {
				log.info("got new login key");
				data.loginKey = loginKey;
				this.bridge.setPuppetData(puppetId, data);
			});

			client.chat.on("friendMessage", (message) => {
				this.handleFriendMessage(puppetId, message);
			});
			client.chat.on("friendMessageEcho", (message) => {
				this.handleFriendMessage(puppetId, message, client.steamID);
			});
			client.chat.on("friendTyping", (message: IIncomingFriendMessage) => {
				this.handleFriendTyping(puppetId, message);
			});
			client.chat.on("chatMessage", (message) => {
				this.handleChatMessage(puppetId, message);
			});

			client.on("error", (err) => {
				log.error(`Failed to start up puppet ${puppetId}`, err);
				this.bridge.sendStatusMessage(puppetId, `**disconnected!**: failed to connect. ${err}`);
			});
		} catch (err) {
			log.error(`Failed to start up puppet ${puppetId}`, err);
			await this.bridge.sendStatusMessage(puppetId, `**disconnected!**: failed to connect. ${err}`);
		}
	}

	public async deletePuppet(puppetId: number) {
		log.info(`Got signal to quit Puppet: puppetId=${puppetId}`);
		const p = this.puppets[puppetId];
		if (!p) {
			return; // nothing to do
		}

		p.client.logOff();

		delete this.bridge[puppetId];
	}

	private getRoomSteamId(room: IRemoteRoom): SteamID | null {
		try {
			const steamId = new SteamID(room.roomId);
			if (steamId.isValid()) {
				return steamId;
			} else {
				return null;
			}
		} catch (e) {
			return null;
		}
	}

	public async handleFriendMessage(puppetId: number, message: IIncomingFriendMessage, fromSteamId?: SteamID) {
		const p = this.puppets[puppetId];
		log.verbose("Got friend message from steam to pass on");

		let sendParams = await this.getFriendMessageSendParams(puppetId, message, fromSteamId);

		await this.sendMessage(p, sendParams, message);
	}

	public async handleChatMessage(puppetId: number, message: IIncomingChatMessage, fromSteamId?: SteamID) {
		const p = this.puppets[puppetId];
		log.verbose("Got chat message from steam to pass on");

		let sendParams = await this.getChatMessageSendParams(puppetId, message, fromSteamId);

		await this.sendMessage(p, sendParams, message);
	}

	public async sendMessage(puppet: ISteamPuppet, sendParams: IReceiveParams, message: IIncomingFriendMessage | IIncomingChatMessage) {
		// message is only an embedded image
		if (
			message.message_bbcode_parsed
			&& message.message_bbcode_parsed.length === 1
			&& isBBCode(message.message_bbcode_parsed[0])
			&& message.message_bbcode_parsed[0].tag === 'img'
			&& message.message_no_bbcode === message.message_bbcode_parsed[0].attrs['src']
		) {
			const url = message.message_bbcode_parsed[0].attrs['src'];
			let i = puppet.ourSendImages.indexOf(url);
			if (i === -1) {
				await this.bridge.sendImage(sendParams, url);
			} else {
				// image came from us, dont send
				puppet.ourSendImages.splice(i);
			}
		} else {
			await this.bridge.sendMessage(sendParams, {
				body: message.message_no_bbcode,
			});
		}
	}

	public async handleFriendTyping(puppetId: number, message: IIncomingFriendMessage) {
		await this.bridge.setUserTyping({
			room: {
				puppetId,
				roomId: message.steamid_friend.toString(),
			},
			user: {
				puppetId,
				userId: message.steamid_friend.toString(),
			},
		}, true);
	}

	public async sendMessageToSteam(
		p: ISteamPuppet,
		room: IRemoteRoom,
		eventId: string,
		msg: string,
		mediaId?: string,
	) {
		if (this.getRoomSteamId(room)) {
			const sendMessage = await p.client.chat.sendFriendMessage(room.roomId, msg);
			let id = `${sendMessage.server_timestamp.toISOString()}::${sendMessage.ordinal}`;

			await this.bridge.eventSync.insert(room, eventId, id);
			p.sentEventIds.push(id);
		} else {
			let [groupId, chatId] = this.parseChatRoomId(room.roomId);

			const sendMessage = await p.client.chat.sendChatMessage(groupId, chatId, msg);
			let id = `${sendMessage.server_timestamp.toISOString()}::${sendMessage.ordinal}`;

			await this.bridge.eventSync.insert(room, eventId, id);
			p.sentEventIds.push(id);
		}
	}

	public async handleMatrixMessage(room: IRemoteRoom, data: IMessageEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got message to send on");
		// room.roomId, data.body
		await this.sendMessageToSteam(p, room, data.eventId!, data.body);
	}

	public async handleMatrixImage(room: IRemoteRoom, data: IFileEvent, event: any) {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return;
		}
		log.verbose("Got image to send on");

		let steamId = this.getRoomSteamId(room);
		if (steamId) {
			const buffer = await Util.DownloadFile(data.url);
			let sendUrl: string = await new Promise((resolve, reject) => p.community.sendImageToUser(steamId, buffer, (err, imageUrl) => {
				if (err) {
					reject(err);
				} else {
					resolve(imageUrl);
				}
			}));
			// since we send images trough SteamCommunity and not SteamUser we get them back as `friendMessageEcho`
			// so we need to track them to make sure we dont double post them
			p.ourSendImages.push(sendUrl);
		} else {
			await this.bridge.sendStatusMessage(room.puppetId, `Sending images to groups is currently not supported`);
		}
	}

	public async createUser(user: IRemoteUser): Promise<IRemoteUser | null> {
		const p = this.puppets[user.puppetId];
		if (!p) {
			return null;
		}
		let persona = await this.getPersona(p, new SteamID(user.userId));

		log.info(`Got request to create user ${user.userId}`);
		return {
			userId: user.userId,
			puppetId: user.puppetId,
			name: persona.player_name,
			avatarUrl: persona.avatar_url_medium
		};
	}

	public async listUsers(puppetId: number): Promise<IRetList[]> {
		let friends = this.puppets[puppetId].client.users as { [steamId: string]: IPersona };

		return Object.keys(friends).map((steamId) => ({
			id: steamId,
			name: friends[steamId].player_name
		}));
	}

	public async getDmRoomId(user: IRemoteUser): Promise<string | null> {
		log.info(`Got request for dm room id for ${user.userId}`);

		if (!this.puppets[user.puppetId]) {
			return null;
		}

		return user.userId;
	}

	public async createRoom(room: IRemoteRoom): Promise<IRemoteRoom | null> {
		const p = this.puppets[room.puppetId];
		if (!p) {
			return null;
		}

		let steamId = this.getRoomSteamId(room);
		if (steamId) {
			let persona = await this.getPersona(p, steamId);

			log.info(`Got request to room user ${room.roomId}`);
			return {
				puppetId: room.puppetId,
				roomId: room.roomId,
				isDirect: true,
				name: persona.player_name
			};
		} else {
			let [groupId, chatId] = this.parseChatRoomId(room.roomId);
			let chat_room_group = await this.getGroupInfo(p, groupId);
			if (chat_room_group) {
				let chat_room = chat_room_group.group_summary.chat_rooms.find((chat) => chat.chat_id == chatId);
				let name = chat_room_group.group_summary.chat_group_name;
				if (chat_room) {
					name = `${name} | ${chat_room.chat_name}`;
				}

				return {
					puppetId: room.puppetId,
					roomId: `chat_${groupId}_${chatId}`,
					isDirect: false,
					groupId: groupId,
					name,
					avatarUrl: chat_room_group.group_summary.chat_group_avatar_url,
				};
			}
		}

		await this.bridge.sendStatusMessage(room.puppetId, `Invalid room id or unknown chat: ${room.roomId}`);
		return null;
	}

	public async getGroupInfo(puppet: ISteamPuppet, groupId: string): Promise<IGroupDetails | null> {
		let {chat_room_groups} = await new Promise((resolve, reject) => puppet.client.chat.getGroups((err, response) => {
			if (err) {
				reject(err);
			} else {
				resolve(response);
			}
		}));

		let chat_room_group = chat_room_groups[groupId];
		if (chat_room_group) {
			return chat_room_group as IGroupDetails;
		} else {
			return null;
		}
	}

	public async createGroup(group: IRemoteGroup): Promise<IRemoteGroup | null> {
		const p = this.puppets[group.puppetId];
		if (!p) {
			return null;
		}

		let chat_room_group = await this.getGroupInfo(p, group.groupId);

		if (!chat_room_group) {
			return null;
		}

		return {
			puppetId: group.puppetId,
			groupId: group.groupId,
			name: chat_room_group.group_summary.chat_group_name,
			avatarUrl: chat_room_group.group_summary.chat_group_avatar_url,
		};
	}
}
