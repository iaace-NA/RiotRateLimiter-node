"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const RateLimiter_1 = require("../RateLimiter");
const requestP = require('request-promise');
const Bluebird = require('bluebird');
const RiotRateLimiterParameterError_1 = require("../errors/RiotRateLimiterParameterError");
const index_1 = require("../RateLimit/index");
class RiotRateLimiter {
    constructor({ strategy = RateLimiter_1.STRATEGY.SPREAD, debug = false }) {
        this.strategy = strategy;
        this.debug = debug;
        this.limitersPerPlatformId = {};
    }
    executing({ url, token, resolveWithFullResponse = false }) {
        const { platformId, apiMethod } = RiotRateLimiter.extractPlatformIdAndMethodFromUrl(url);
        if (!this.limitersPerPlatformId[platformId]) {
            this.limitersPerPlatformId[platformId] = {};
        }
        if (!this.limitersPerPlatformId[platformId][apiMethod]) {
            console.log('creating sync rate limimter for ', platformId, apiMethod);
            this.limitersPerPlatformId[platformId][apiMethod] = new RateLimiter_1.default({
                limits: [RateLimiter_1.default.createSyncRateLimit(this.debug)],
                strategy: this.strategy,
                debug: this.debug
            });
            if (this.debug) {
                console.log('RateLimiterChain for init request created\r\n' + this.limitersPerPlatformId[platformId][apiMethod].toString());
            }
        }
        return this.limitersPerPlatformId[platformId][apiMethod]
            .scheduling((rateLimiter) => {
            return this.executingScheduledCallback(rateLimiter, {
                url,
                token,
                resolveWithFullResponse
            });
        });
    }
    executingScheduledCallback(rateLimiter, { url, token, resolveWithFullResponse = false }) {
        return Bluebird.resolve().then(() => {
            if (!url) {
                throw new RiotRateLimiterParameterError_1.default('URL has to be provided for the ApiRequest');
            }
            if (!token) {
                throw new RiotRateLimiterParameterError_1.default('options.token has to be provided for the ApiRequest');
            }
            let options = {
                url: url,
                method: 'GET',
                headers: { 'X-Riot-Token': token },
                resolveWithFullResponse,
                transform: (body, response, resolveWithFullResponse) => {
                    let updatedLimits = [];
                    if (this.debug) {
                        console.log(response.statusCode);
                        console.log(response.headers);
                    }
                    if (response.headers['x-app-rate-limit']) {
                        const appRateLimits = RiotRateLimiter.extractRateLimitFromHeader(index_1.RATELIMIT_TYPE.APP, response.headers['x-app-rate-limit']);
                        if (response.headers['x-app-rate-limit-count']) {
                            RiotRateLimiter.addRequestsCountFromHeader(index_1.RATELIMIT_TYPE.APP, appRateLimits, response.headers['x-app-rate-limit-count']);
                        }
                        this.updateAppRateLimits(appRateLimits);
                        updatedLimits = updatedLimits.concat(appRateLimits);
                    }
                    if (response.headers['x-method-rate-limit']) {
                        const methodRateLimits = RiotRateLimiter.extractRateLimitFromHeader(index_1.RATELIMIT_TYPE.METHOD, response.headers['x-method-rate-limit']);
                        if (response.headers['x-method-rate-limit-count']) {
                            RiotRateLimiter.addRequestsCountFromHeader(index_1.RATELIMIT_TYPE.METHOD, methodRateLimits, response.headers['x-method-rate-limit-count']);
                        }
                        updatedLimits = updatedLimits.concat(methodRateLimits);
                    }
                    if (updatedLimits.length > 0) {
                        if (this.debug) {
                            console.log('limitOptions from headers:');
                            console.log(JSON.stringify(updatedLimits, null, 2));
                        }
                        rateLimiter.updateLimits(updatedLimits);
                    }
                    if (response.statusCode === 429) {
                        let retryAfterMS;
                        if (response.headers['retry-after']) {
                            if (this.debug) {
                                console.warn('Rate limit exceeded on X-Rate-Limit-Type: ' + response.headers['x-rate-limit-type']);
                                console.warn('Backing off and continue requests after: ' + response.headers['retry-after']);
                                console.warn('Request url: ' + url);
                            }
                            retryAfterMS = parseInt(response.headers['retry-after']) * 1000;
                        }
                        else {
                            if (this.debug) {
                                console.warn('Rate limit exceeded on underlying system for ' + url);
                            }
                        }
                        rateLimiter.backoff({ retryAfterMS });
                        return response;
                    }
                    return resolveWithFullResponse ? response : body;
                }
            };
            return requestP(options)
                .catch(err => {
                if (err.statusCode !== 429) {
                    throw err;
                }
                else {
                    if (this.debug) {
                        console.warn('rescheduling request on ' + rateLimiter.toString());
                    }
                    return rateLimiter.rescheduling((rateLimiter) => {
                        return this.executingScheduledCallback(rateLimiter, {
                            url,
                            token,
                            resolveWithFullResponse
                        });
                    });
                }
            });
        });
    }
    static extractPlatformIdAndMethodFromUrl(url) {
        let platformId;
        let apiMethod;
        try {
            platformId = url.match(/\/\/(.*?)\./)[1];
            apiMethod = url
                .replace(/\?.*/g, '')
                .replace(/\/\d+/g, '/');
        }
        catch (e) {
            throw new Error('Could not extract PlatformId and Methot from url: ' + url);
        }
        if (!platformId || !apiMethod)
            throw new Error('Could not extract PlatformId and Methot from url: ' + url);
        return { platformId, apiMethod };
    }
    static extractRateLimitFromHeader(type, rateLimitHeader) {
        return rateLimitHeader.split(',')
            .map(limitString => {
            const [requests, seconds] = limitString.split(':').map(limitString => parseInt(limitString));
            return { requests, seconds, type };
        });
    }
    static extractRateLimitCountsFromHeader(type, rateLimitCountHeader) {
        return rateLimitCountHeader
            .split(',')
            .map(limitCountString => {
            const [count, seconds] = limitCountString.split(':')
                .map(limitOrCountString => parseInt(limitOrCountString));
            return { count, seconds, type };
        });
    }
    static addRequestsCountFromHeader(type, updatedLimits, rateLimitCountHeader) {
        const limitCounts = RiotRateLimiter.extractRateLimitCountsFromHeader(type, rateLimitCountHeader);
        return updatedLimits.map(options => {
            const limitCountUpdate = limitCounts.find(rateLimitCount => rateLimitCount.seconds === options.seconds);
            if (limitCountUpdate) {
                options.count = limitCountUpdate.count;
            }
            return options;
        });
    }
    toString(url) {
        if (url) {
            const { platformId, apiMethod } = RiotRateLimiter.extractPlatformIdAndMethodFromUrl(url);
            if (this.limitersPerPlatformId[platformId][apiMethod]) {
                return this.limitersPerPlatformId[platformId][apiMethod].toString();
            }
        }
        else {
            return JSON.stringify(this.limitersPerPlatformId, null, 2);
        }
    }
    setStrategy(strategy) {
        this.strategy = strategy;
        Object.keys(this.limitersPerPlatformId).forEach(platformId => {
            Object.keys(this.limitersPerPlatformId[platformId]).forEach((methodName) => {
                this.limitersPerPlatformId[platformId][methodName].setStrategy(strategy);
            });
        });
    }
    updateAppRateLimits(updateOptions = []) {
        if (updateOptions.length === 0) {
            return null;
        }
        let updateOptionsCopy = updateOptions.slice();
        if (!this.appLimits || this.appLimits.length === 0) {
            this.appLimits = updateOptionsCopy.map(options => new index_1.default(options, { debug: this.debug }));
        }
        else {
            this.appLimits = this.appLimits.filter(limit => {
                const optionsForLimit = updateOptionsCopy.find((options, index) => {
                    if (limit.seconds === options.seconds) {
                        updateOptionsCopy.splice(index, 1);
                        return true;
                    }
                    else
                        return false;
                });
                if (optionsForLimit) {
                    return true;
                }
                else {
                    limit.dispose();
                    return false;
                }
            });
            if (updateOptionsCopy.length > 0) {
                this.appLimits = this.appLimits.concat(updateOptionsCopy.map(options => new index_1.default(options, { debug: this.debug })));
            }
        }
    }
}
exports.default = RiotRateLimiter;