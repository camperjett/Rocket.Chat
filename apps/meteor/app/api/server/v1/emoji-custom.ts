import { Meteor } from 'meteor/meteor';
import { EmojiCustom } from '@rocket.chat/models';

import { API } from '../api';
import { getUploadFormData } from '../lib/getUploadFormData';
import { findEmojisCustom } from '../lib/emoji-custom';
import { Media } from '../../../../server/sdk';

API.v1.addRoute(
	'emoji-custom.list',
	{ authRequired: true },
	{
		async get() {
			const { query } = this.parseJsonQuery();
			const { updatedSince } = this.queryParams;
			if (updatedSince) {
				const updatedSinceDate = new Date(updatedSince);
				if (isNaN(Date.parse(updatedSince))) {
					throw new Meteor.Error('error-roomId-param-invalid', 'The "updatedSince" query parameter must be a valid date.');
				}
				const [update, remove] = await Promise.all([
					EmojiCustom.find({ ...query, _updatedAt: { $gt: updatedSinceDate } }).toArray(),
					EmojiCustom.trashFindDeletedAfter(updatedSinceDate).toArray(),
				]);
				return API.v1.success({
					emojis: {
						update,
						remove,
					},
				});
			}

			return API.v1.success({
				emojis: {
					update: await EmojiCustom.find(query).toArray(),
					remove: [],
				},
			});
		},
	},
);

API.v1.addRoute(
	'emoji-custom.all',
	{ authRequired: true },
	{
		async get() {
			const { offset, count } = this.getPaginationItems();
			const { sort, query } = this.parseJsonQuery();

			return API.v1.success(
				await findEmojisCustom({
					query,
					pagination: {
						offset,
						count,
						sort,
					},
				}),
			);
		},
	},
);

API.v1.addRoute(
	'emoji-custom.create',
	{ authRequired: true },
	{
		async post() {
			const [emoji, fields] = await getUploadFormData(
				{
					request: this.request,
				},
				{ field: 'emoji' },
			);

			const isUploadable = await Media.isImage(emoji.fileBuffer);
			if (!isUploadable) {
				throw new Meteor.Error('emoji-is-not-image', "Emoji file provided cannot be uploaded since it's not an image");
			}

			const [, extension] = emoji.mimetype.split('/');
			fields.extension = extension;

			Meteor.call('insertOrUpdateEmoji', {
				...fields,
				newFile: true,
				aliases: fields.aliases || '',
			});
			Meteor.call('uploadEmojiCustom', emoji.fileBuffer, emoji.mimetype, {
				...fields,
				newFile: true,
				aliases: fields.aliases || '',
			});

			return API.v1.success();
		},
	},
);

API.v1.addRoute(
	'emoji-custom.update',
	{ authRequired: true },
	{
		async post() {
			const [emoji, fields] = await getUploadFormData(
				{
					request: this.request,
				},
				{ field: 'emoji' },
			);

			if (!fields._id) {
				throw new Meteor.Error('The required "_id" query param is missing.');
			}

			const emojiToUpdate = Promise.await(EmojiCustom.findOneById(fields._id));
			if (!emojiToUpdate) {
				throw new Meteor.Error('Emoji not found.');
			}

			fields.previousName = emojiToUpdate.name;
			fields.previousExtension = emojiToUpdate.extension;
			fields.aliases = fields.aliases || '';
			const newFile = Boolean(emoji?.fileBuffer.length);

			if (fields.newFile) {
				const isUploadable = Promise.await(Media.isImage(emoji.fileBuffer));
				if (!isUploadable) {
					throw new Meteor.Error('emoji-is-not-image', "Emoji file provided cannot be uploaded since it's not an image");
				}

				const [, extension] = emoji.mimetype.split('/');
				fields.extension = extension;
			} else {
				fields.extension = emojiToUpdate.extension;
			}

			Meteor.call('insertOrUpdateEmoji', { ...fields, newFile });
			if (fields.newFile) {
				Meteor.call('uploadEmojiCustom', emoji.fileBuffer, emoji.mimetype, { ...fields, newFile });
			}
			return API.v1.success();
		},
	},
);

API.v1.addRoute(
	'emoji-custom.delete',
	{ authRequired: true },
	{
		post() {
			const { emojiId } = this.bodyParams;
			if (!emojiId) {
				return API.v1.failure('The "emojiId" params is required!');
			}

			Meteor.call('deleteEmojiCustom', emojiId);

			return API.v1.success();
		},
	},
);
