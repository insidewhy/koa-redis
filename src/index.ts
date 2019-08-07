/** !
 * koa-redis-snowman - index.js
 * Copyright(c) 2015-2019
 * MIT Licensed
 *
 * Authors:
 *   dead_horse <dead_horse@qq.com> (http://deadhorse.me)
 *   ohjames <github@chilon.net> (http://chilon.net)
 */

/**
 * Module dependencies.
 */

import * as debugMod from 'debug';
import * as ioredis from 'ioredis';
import { Session } from 'koa-session';

const debug = debugMod('koa-redis-snowman');

interface RedisStoreOptions {
  isRedisCluster: boolean;
  client: ioredis.Redis | ioredis.Cluster;
}

declare module 'ioredis' {
  interface Cluster {
    setex: (sid: string, ttl: number, data: string) => Promise<void>;
    expire: (sid: string, ttl: number) => Promise<void>;
    del: (sid: string) => Promise<void>;
    select: (dbName: string) => Promise<void>;
  }
}

/**
 * Initialize redis session middleware with `opts` (see the README for more info):
 *
 * @param {Object} options
 *   - {Boolean} isRedisCluster redis is cluster
 *   - {Object} client       redis client (overides all other options except db and duplicate)
 *   - {String} db           redis db
 *   - {Boolean} duplicate   if own client object, will use node redis's duplicate function and pass other options
 *   - {String} password     redis password
 *   - {Any} [any]           all other options including above are passed to ioredis
 * @returns {Object} Redis instance
 */
class RedisStore {
  options: RedisStoreOptions;
  client: ioredis.Redis | ioredis.Cluster;
  serialize: (obj: any) => string;
  deserialize: (str: string) => any;

  constructor(options: any = {}) {
    this.options = options;

    options.password = options.password; // For backwards compatibility
    options.path = options.path; // For backwards compatibility
    if (!options.client) {
      //
      // TODO: we should probably omit custom options we have
      // in this lib from `options` passed to instances below
      //
      if (options.isRedisCluster) {
        debug('Initializing Redis Cluster');
        delete options.isRedisCluster;
        this.client = new ioredis.Cluster(
          options.nodes,
          options.clusterOptions
        );
      } else {
        debug('Initializing Redis');
        delete options.isRedisCluster;
        delete options.nodes;
        delete options.clusterOptions;
        this.client = new ioredis(options);
      }
    } else if (options.duplicate) {
      // Duplicate client and update with options provided
      debug('Duplicating provided client with new options (if provided)');
      const dupClient = options.client;
      delete options.client;
      delete options.duplicate;
      // Useful if you want to use the DB option without adjusting the client DB outside koa-redis-snowman
      this.client = dupClient.duplicate(options);
    } else {
      debug('Using provided client');
      this.client = options.client;
    }

    if (options.db) {
      debug('selecting db %s', options.db);
      this.client.select(options.db);

      this.client.on('connect', () => {
        this.client.select(options.db);
      });
    }

    // Support optional serialize and deserialize
    this.serialize = options.serialize || JSON.stringify;
    this.deserialize = options.deserialize || JSON.parse;
  }

  async get(
    sid: string,
    maxAge: number,
    options: { rolling: boolean | undefined }
  ) {
    const data = await this.client.get(sid);
    debug('get session: %s', data || 'none');
    if (!data) {
      return undefined;
    }

    try {
      if (maxAge && options.rolling) {
        await this.client.expire(sid, maxAge);
      }
      return this.deserialize(data.toString());
    } catch (err) {
      // ignore err
      debug('parse session error: %s', err.message);
    }
  }

  async set(
    sid: string,
    sess: Session,
    maxAge: number,
    options: { rolling: boolean | undefined; changed: boolean | undefined }
  ) {
    if (options.changed) {
      try {
        const sessStr = this.serialize(sess);
        if (maxAge) {
          const ttl = Math.ceil(maxAge / 1000);
          debug('SETEX %s %s %s', sid, ttl, sessStr);
          await this.client.setex(sid, ttl, sessStr);
        } else {
          debug('SET %s %s', sid, sessStr);
          await this.client.set(sid, sessStr);
        }

        debug('SET %s complete', sid);
      } catch (e) {
        // ignore bad session error
        debug('SET %s failed', sid);
      }
    } else {
      if (options.rolling) {
        await this.client.expire(sid, maxAge);
        debug('EXPIRE %s complete', sid);
      } else {
        debug('SET not done as %s was unchanged', sid);
      }
    }
  }

  async destroy(sid: string) {
    debug('DEL %s', sid);
    await this.client.del(sid);
    debug('DEL %s complete', sid);
  }

  async quit() {
    debug('quit');
    await this.client.quit();
  }
}

export default RedisStore;
