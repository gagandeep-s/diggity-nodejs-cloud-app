/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// [START import]
const functions = require('firebase-functions');
const gcs = require('@google-cloud/storage')();
const spawn = require('child-process-promise').spawn;
const admin = require('firebase-admin');
const nodeTwitterApi = require("node-twitter-api");
const adminSdkPrivateKey = require('./diggity-development-firebase-adminsdk-private-key.json');
const socialConfig = require('./social-config.json');
const i18n = {
    en: require('./i18n/en.json')
};
const activityTypes = {
    diaryAdded: "diary_added",
    diaryDeleted: "diary_deleted",
    diaryLiked: "diary_like",
    diaryCommented: "diary_commented",

    entryAdded: "entry_added",
    entryDeleted: "entry_deleted",
    entryLiked: "entry_like",
    entryCommented: "entry_commented",

    storyAdded: "story_added",
    storyDeleted: "story_deleted",
    storyLiked: "story_like",
    storyCommented: "story_commented",

    imageAdded: "image_added",
    imageDeleted: "image_deleted",
    imageLiked: "image_like",
    imageCommented: "image_commented",

    collectionAdded: "collection_added",    
    collectionDeleted: "collection_deleted",    
    collectionLiked: "collection_like",
    collectionCommented: "collection_commented",

    videoAdded: "video_added",
    videoDeleted: "video_deleted",
    videoLiked: "video_like",
    videoCommented: "video_commented"
};
const request = require('request');
const cors = require('cors')({ origin: true });
const moment = require('moment');
// [END import]

const firebaseConfig = functions.config().firebase;
firebaseConfig.credential = admin.credential.cert(adminSdkPrivateKey);
admin.initializeApp(firebaseConfig);

// [START generateThumbnail]
/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 */
// [START generateThumbnailTrigger]
exports.generateThumbnail = functions.storage.object().onChange(event => {
    // [END generateThumbnailTrigger]
    // [START eventAttributes]
    const object = event.data; // The Storage object.

    const fileBucket = object.bucket; // The Storage bucket that contains the file.
    const filePath = object.name; // File path in the bucket.
    const contentType = object.contentType; // File content type.
    console.log("File Content Type: " + contentType);

    // Declare default file extension.
    let fileExtn = ".png";

    // Check content type to set file extension.
    if (contentType) {
        switch (contentType.toLowerCase()) {
            case "image/png":
                fileExtn = ".png"
                break;

            case "image/bmp":
                fileExtn = ".bmp"
                break;

            case "image/gif":
                fileExtn = ".gif"
                break;

            case "image/jpeg":
            case "image/jpg":
                fileExtn = ".jpg"
                break;

            case "image/tiff":
            case "image/x-tiff":
                fileExtn = ".tiff"
                break;
        }
    }
    const resourceState = object.resourceState; // The resourceState is 'exists' or 'not_exists' (for file/folder deletions).
    // [END eventAttributes]

    // [START stopConditions]
    // Exit if this is triggered on a file that is not an image.
    if (!contentType.startsWith("image/")) {
        console.log("This is not an image.");
        return;
    }

    // Get the file name.
    const fileName = filePath.split("/").pop();
    // Exit if the image is already a thumbnail.
    if (fileName.startsWith("thumb_")) {
        console.log("Already a Thumbnail.");
        return;
    }

    // Exit if this is a move or deletion event.
    if (resourceState === "not_exists") {
        console.log("This is a deletion event.");
        return;
    }
    // [END stopConditions]

    // [START thumbnailGeneration]
    // Download file from bucket.
    const bucket = gcs.bucket(fileBucket);
    const tempFilePath = `/tmp/${fileName}.${fileExtn}`;
    return bucket.file(filePath).download({
        destination: tempFilePath
    }).then(() => {
        console.log("Image downloaded locally to", tempFilePath);

        // Generate a thumbnail using ImageMagick.

        // 200x200 
        spawn("convert", [tempFilePath, "-thumbnail", "200x200>", tempFilePath]).then(() => {
            console.log("Thumbnail created at", tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + "/" + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_200_200`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });

        // 400x400 
        spawn("convert", [tempFilePath, "-thumbnail", "400x400>", tempFilePath]).then(() => {
            console.log("Thumbnail created at", tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + "/" + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_400_400`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });

        // 600x600 
        return spawn("convert", [tempFilePath, "-thumbnail", "600x600>", tempFilePath]).then(() => {
            console.log("Thumbnail created at", tempFilePath);
            // We add a 'thumb_' prefix to thumbnails file name. That's where we'll upload the thumbnail.
            const thumbFilePath = fileName + "/" + filePath.replace(/(\/)?([^\/]*)$/, `$1thumb_$2_600_600`);
            // Uploading the thumbnail.
            return bucket.upload(tempFilePath, {
                destination: thumbFilePath
            });
        });
    });
    // [END thumbnailGeneration]
});
// [END generateThumbnail]

// [START handleSocialLogin]
/**
 * Handle Social login using Facebook, Google, Instagram & Twitter.
 */
// [START handleSocialLoginTrigger]
exports.handleSocialLogin = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req && req.query && req.query.client_id && req.query.redirect_uri && req.query.redirect_uri === socialConfig.redirectUrl) {
            let twitterApi = new nodeTwitterApi({
                consumerKey: socialConfig.twitter.consumerKey,
                consumerSecret: socialConfig.twitter.consumerSecret,
                callback: socialConfig.redirectUrl
            });

            twitterApi.getRequestToken(function (error, requestToken, requestSecret) {
                if (!error && requestToken && requestSecret) {
                    let updates = {};
                    updates[`/twitterRequestTokenSecrets/${req.query.client_id}`] = requestSecret;
                    admin.database().ref().update(updates).then(() => {
                        res.redirect(`https://api.twitter.com/oauth/authenticate?oauth_token=${requestToken}`);
                    }).catch(() => {
                        console.log("Unable to save Twitter RequestTokenSecret");
                        res.redirect(socialConfig.redirectUrl);
                    });
                } else {
                    console.log("Error fetching Twitter Request Token:", error);
                    res.redirect(socialConfig.redirectUrl);
                }
            });
        } else if (req && req.query && (req.query.provider && (req.query.provider === "facebook" || (req.query.provider === "google" || req.query.provider === "google-cordova") || req.query.provider === "instagram" || req.query.provider === "twitter")) && req.query.code) {
            let islinking = req.query.uid ? true : false;

            let promiseFirebaseUserRecordForLinking = Promise.resolve({});
            if (islinking) {
                promiseFirebaseUserRecordForLinking = admin.auth().getUser(req.query.uid).then((userRecord) => {
                    if (userRecord) {
                        return Promise.resolve(userRecord);
                    } else {
                        return Promise.resolve(null);
                    }
                }).catch(() => {
                    return Promise.resolve(null);
                });
            }
            promiseFirebaseUserRecordForLinking.then(firebaseUserRecordForLinking => {
                if (firebaseUserRecordForLinking) {
                    let socialLoginHandle = function (socialUserAccessToken, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl, socialUserExtraData) {
                        admin.database().ref(`/socialIdentities/${req.query.provider}/${socialUserId}`).once("value").then(function (snapshot) {
                            let socialIdentity = snapshot.val();
                            if (islinking && socialIdentity) {
                                res.status(200).send({ socialUserAlreadyExists: true });
                            } else {
                                let promiseFirebaseUserRecordByEmail = Promise.resolve(null);
                                if (!islinking && !socialIdentity && socialUserEmail) {
                                    promiseFirebaseUserRecordByEmail = admin.auth().getUserByEmail(socialUserEmail).then((userRecord) => {
                                        if (userRecord) {
                                            return Promise.resolve(userRecord);
                                        } else {
                                            return Promise.resolve(null);
                                        }
                                    }).catch(() => {
                                        return Promise.resolve(null);
                                    });
                                }
                                promiseFirebaseUserRecordByEmail.then(firebaseUserRecordByEmail => {
                                    if (firebaseUserRecordByEmail) {
                                        admin.database().ref(`/userSocialIdentities/${firebaseUserRecordByEmail.uid}`).once("value").then(function (snapshot) {
                                            let firebaseUserSocialIdentities = snapshot.val();

                                            let socialProviders = [];
                                            for (let provider in firebaseUserSocialIdentities) {
                                                socialProviders.push(provider);
                                            }

                                            res.status(200).send({
                                                emailAlreadyExists: true,
                                                email: socialUserEmail,
                                                socialProviders: socialProviders,
                                                socialUser: {
                                                    provider: req.query.provider,
                                                    id: socialUserId,
                                                    accessToken: socialUserAccessToken,
                                                    extraData: socialUserExtraData
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    } else {
                                        let firebaseUserId = (islinking ? req.query.uid : (socialIdentity && socialIdentity.firebaseUserId ? socialIdentity.firebaseUserId : `${req.query.provider}UserId::${socialUserId}`));

                                        let updates = {};
                                        updates[`/socialIdentities/${req.query.provider}/${socialUserId}`] = {
                                            accessToken: socialUserAccessToken,
                                            firebaseUserId: firebaseUserId
                                        };
                                        if (socialUserExtraData) {
                                            for (let socialUserExtraDataKey in socialUserExtraData) {
                                                if (socialUserExtraData[socialUserExtraDataKey]) {
                                                    updates[`/socialIdentities/${req.query.provider}/${socialUserId}`][socialUserExtraDataKey] = socialUserExtraData[socialUserExtraDataKey];
                                                }
                                            }
                                        }
                                        updates[`/userSocialIdentities/${firebaseUserId}/${req.query.provider}`] = {
                                            userId: socialUserId
                                        };

                                        admin.database().ref().update(updates).then(() => {
                                            let isUpdatedUserPropertiesFound = false;
                                            let userProperties = {};

                                            if ((!firebaseUserRecordForLinking.displayName || firebaseUserRecordForLinking.displayName === "") && socialUserName) {
                                                userProperties.displayName = socialUserName;
                                                isUpdatedUserPropertiesFound = true;
                                            }
                                            if ((!firebaseUserRecordForLinking.photoURL || firebaseUserRecordForLinking.photoURL === "") && socialUserProfilePictureUrl) {
                                                userProperties.photoURL = socialUserProfilePictureUrl;
                                                isUpdatedUserPropertiesFound = true;
                                            }
                                            if (!islinking && !socialIdentity && socialUserEmail) {
                                                userProperties.email = socialUserEmail;
                                                isUpdatedUserPropertiesFound = true;
                                            }

                                            let promiseUpdateOrCreateFirebaseUser = Promise.resolve();
                                            if (isUpdatedUserPropertiesFound) {
                                                promiseUpdateOrCreateFirebaseUser = admin.auth().updateUser(firebaseUserId, userProperties).catch(error => {
                                                    if (!islinking && error.code === "auth/user-not-found") {
                                                        userProperties.uid = firebaseUserId;

                                                        return admin.auth().createUser(userProperties).catch(() => {
                                                            return Promise.resolve();
                                                        });
                                                    } else {
                                                        return Promise.resolve();
                                                    }
                                                });
                                            }

                                            promiseUpdateOrCreateFirebaseUser.then(() => {
                                                if (islinking) {
                                                    res.status(200).send({ islinked: true });
                                                } else {
                                                    admin.auth().createCustomToken(firebaseUserId).then((customToken) => {
                                                        res.status(200).send({ token: customToken });
                                                    }).catch(() => {
                                                        res.status(200).send({ error: true });
                                                    });
                                                }
                                            });
                                        }).catch(() => {
                                            res.status(200).send({ error: true });
                                        });
                                    }
                                });
                            }
                        }).catch(() => {
                            res.status(200).send({ error: true });
                        });
                    };

                    if (req.query.provider === "google-cordova") {
                        req.query.provider = "google";

                        let isQueryCodeParseable = true;
                        try {
                            req.query.code = JSON.parse(req.query.code);
                        } catch (e) {
                            console.log("Code is not parsable:", {
                                query: req.query,
                                parseError: e
                            });
                            isQueryCodeParseable = false;
                        }
                        if (isQueryCodeParseable) {
                            let socialUserId;
                            let socialUserEmail;
                            let socialUserName;
                            let socialUserProfilePictureUrl;
                            let socialUserServerAuthCode;
                            let socialUserIdToken;
                            let socialUserAccessToken;
                            let socialUserRefreshToken;

                            if (req.query.code.userId) {
                                socialUserId = req.query.code.userId;
                            }

                            if (req.query.code.email) {
                                socialUserEmail = req.query.code.email;
                            }

                            if (req.query.code.displayName) {
                                socialUserName = req.query.code.displayName;
                            }

                            if (req.query.code.imageUrl) {
                                socialUserProfilePictureUrl = req.query.code.imageUrl;
                            }

                            if (req.query.code.serverAuthCode) {
                                socialUserServerAuthCode = req.query.code.serverAuthCode;
                            }

                            if (req.query.code.idToken) {
                                socialUserIdToken = req.query.code.idToken;
                            }

                            if (req.query.code.accessToken) {
                                socialUserAccessToken = req.query.code.accessToken;
                            }

                            if (req.query.code.refreshToken) {
                                socialUserRefreshToken = req.query.code.refreshToken;
                            }

                            if (socialUserAccessToken) {
                                socialLoginHandle(socialUserAccessToken, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl, {
                                    serverAuthCode: socialUserServerAuthCode,
                                    idToken: socialUserIdToken,
                                    refreshToken: socialUserRefreshToken
                                });
                            } else if (socialUserServerAuthCode) {
                                request.post({
                                    url: socialConfig.google.oAuthUrl,
                                    form: {
                                        client_id: socialConfig.google.clientId,
                                        client_secret: socialConfig.google.clientSecret,
                                        grant_type: socialConfig.grantType,
                                        redirect_uri: socialConfig.redirectUrl,
                                        code: socialUserServerAuthCode
                                    }
                                }, function (error, response, body) {
                                    let isPostBodyParseable = true;
                                    try {
                                        body = JSON.parse(body);
                                    } catch (e) {
                                        console.log("Token Response body is not parsable:", {
                                            query: req.query,
                                            postData: postData,
                                            error: error,
                                            response: response,
                                            body: body,
                                            parseError: e
                                        });
                                        isPostBodyParseable = false;
                                    }
                                    if (isPostBodyParseable) {
                                        if (!error && response && response.statusCode === 200 && body && body.access_token) {
                                            socialLoginHandle(body.access_token, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl, {
                                                serverAuthCode: socialUserServerAuthCode,
                                                idToken: socialUserIdToken,
                                                refreshToken: socialUserRefreshToken
                                            });
                                        } else {
                                            console.log("Unexpected Token Response:", {
                                                query: req.query,
                                                postData: postData,
                                                error: error,
                                                response: response,
                                                body: body
                                            });
                                            if (body && ((body.error && body.error.message) || body.error_description || body.error_message)) {
                                                res.status(200).send({ message: (body.error_description || body.error_message || body.error.message) });
                                            } else {
                                                res.status(200).send({ error: true });
                                            }
                                        }
                                    } else {
                                        res.status(200).send({ error: true });
                                    }
                                });
                            } else {
                                res.status(200).send({ error: true });
                            }
                        } else {
                            res.status(200).send({ error: true });
                        }
                    } else if (req.query.provider === "twitter") {
                        let isQueryCodeParseable = true;
                        try {
                            req.query.code = JSON.parse(req.query.code);
                        } catch (e) {
                            console.log("Code is not parsable:", {
                                query: req.query,
                                parseError: e
                            });
                            isQueryCodeParseable = false;
                        }
                        if (isQueryCodeParseable) {
                            if (req.query.client_id) {
                                admin.database().ref(`/twitterRequestTokenSecrets/${req.query.client_id}`).once("value").then(function (snapshot) {
                                    let twitterRequestTokenSecret = snapshot.val();
                                    if (twitterRequestTokenSecret) {
                                        let updates = {};
                                        updates[`/twitterRequestTokenSecrets/${req.query.client_id}`] = null;
                                        let promiseRemoveTwitterRequestTokenSecret = admin.database().ref().update(updates).then(() => {
                                        }).catch(() => {
                                            console.log("Unable to remove Twitter RequestTokenSecret");
                                        });
                                        promiseRemoveTwitterRequestTokenSecret.then(() => {
                                            if (req.query.code.oauth_token && req.query.code.oauth_verifier) {
                                                let twitterApi = new nodeTwitterApi({
                                                    consumerKey: socialConfig.twitter.consumerKey,
                                                    consumerSecret: socialConfig.twitter.consumerSecret,
                                                    callback: socialConfig.redirectUrl
                                                });

                                                twitterApi.getAccessToken(req.query.code.oauth_token, twitterRequestTokenSecret, req.query.code.oauth_verifier, function (error, accessToken, accessSecret) {
                                                    if (!error && accessToken && accessSecret) {
                                                        twitterApi.verifyCredentials(accessToken, accessSecret, { include_email: true }, function (error, twitterUser) {
                                                            if (!error && twitterUser && twitterUser.id) {
                                                                let socialUserEmail;
                                                                let socialUserName;
                                                                let socialUserProfilePictureUrl;

                                                                if (twitterUser.email) {
                                                                    socialUserEmail = twitterUser.email;
                                                                }

                                                                if (twitterUser.name) {
                                                                    socialUserName = twitterUser.name;
                                                                }

                                                                if (twitterUser.profile_image_url) {
                                                                    socialUserProfilePictureUrl = twitterUser.profile_image_url;
                                                                } else if (twitterUser.profile_image_url_https) {
                                                                    socialUserProfilePictureUrl = twitterUser.profile_image_url_https;
                                                                }

                                                                socialLoginHandle(accessToken, twitterUser.id, socialUserEmail, socialUserName, socialUserProfilePictureUrl, {
                                                                    accessSecret: accessSecret
                                                                });
                                                            } else {
                                                                console.log("Error verifying Twitter Access Token:", error);
                                                                res.status(200).send({ error: true });
                                                            }
                                                        });
                                                    } else {
                                                        console.log("Error fetching Twitter Access Token:", error);
                                                        res.status(200).send({ error: true });
                                                    }
                                                });
                                            } else {
                                                res.status(200).send({ error: true });
                                            }
                                        });
                                    } else {
                                        console.log("Unable to retrieve Twitter RequestTokenSecret");
                                        res.status(200).send({ error: true });
                                    }
                                }).catch(() => {
                                    console.log("Unable to retrieve Twitter RequestTokenSecret");
                                    res.status(200).send({ error: true });
                                });
                            } else {
                                res.status(200).send({ error: true });
                            }
                        } else {
                            res.status(200).send({ error: true });
                        }
                    } else {
                        let postData;
                        if (req.query.provider === "facebook") {
                            postData = {
                                url: socialConfig.facebook.oAuthUrl,
                                form: {
                                    client_id: socialConfig.facebook.clientId,
                                    client_secret: socialConfig.facebook.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        } else if (req.query.provider === "google") {
                            postData = {
                                url: socialConfig.google.oAuthUrl,
                                form: {
                                    client_id: socialConfig.google.clientId,
                                    client_secret: socialConfig.google.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        } else if (req.query.provider === "instagram") {
                            postData = {
                                url: socialConfig.instagram.oAuthUrl,
                                form: {
                                    client_id: socialConfig.instagram.clientId,
                                    client_secret: socialConfig.instagram.clientSecret,
                                    grant_type: socialConfig.grantType,
                                    redirect_uri: socialConfig.redirectUrl,
                                    code: req.query.code
                                }
                            };
                        }
                        request.post(postData, function (error, response, body) {
                            let isPostBodyParseable = true;
                            try {
                                body = JSON.parse(body);
                            } catch (e) {
                                console.log("Token Response body is not parsable:", {
                                    query: req.query,
                                    postData: postData,
                                    error: error,
                                    response: response,
                                    body: body,
                                    parseError: e
                                });
                                isPostBodyParseable = false;
                            }
                            if (isPostBodyParseable) {
                                if (!error && response && response.statusCode === 200 && body && body.access_token) {
                                    let socialUserAccessToken = body.access_token;

                                    let getData;
                                    if (req.query.provider === "facebook") {
                                        getData = {
                                            url: `https://graph.facebook.com/v2.9/me?fields=id,email,name,picture&access_token=${socialUserAccessToken}`
                                        };
                                    } else if (req.query.provider === "google") {
                                        getData = {
                                            url: `https://www.googleapis.com/oauth2/v1/userinfo?access_token=${socialUserAccessToken}`
                                        };
                                    } else if (req.query.provider === "instagram") {
                                        getData = {
                                            url: `https://api.instagram.com/v1/users/self?access_token=${socialUserAccessToken}`
                                        };
                                    }
                                    request.get(getData, function (error, response, body) {
                                        let isGetBodyParseable = true;
                                        try {
                                            body = JSON.parse(body);
                                        } catch (e) {
                                            console.log("Profile Response body is not parsable:", {
                                                query: req.query,
                                                getData: getData,
                                                error: error,
                                                response: response,
                                                body: body,
                                                parseError: e
                                            });
                                            isGetBodyParseable = false;
                                        }
                                        if (isGetBodyParseable) {
                                            if (!error && response && response.statusCode === 200 && ((req.query.provider === "facebook" && body.id) || (req.query.provider === "google" && body.id) || (req.query.provider === "instagram" && body.data && body.data.id))) {
                                                let socialUserId;
                                                let socialUserEmail;
                                                let socialUserName;
                                                let socialUserProfilePictureUrl;
                                                let socialUserExtraData;

                                                if (req.query.provider === "facebook") {
                                                    socialUserId = body.id;
                                                    if (body.email) socialUserEmail = body.email;
                                                    if (body.name) socialUserName = body.name;
                                                    if (body.picture && body.picture.data && body.picture.data.url) socialUserProfilePictureUrl = body.picture.data.url;
                                                } else if (req.query.provider === "google") {
                                                    socialUserId = body.id;
                                                    if (body.email) socialUserEmail = body.email;
                                                    if (body.name) socialUserName = body.name;
                                                    if (body.picture) socialUserProfilePictureUrl = body.picture;
                                                    socialUserExtraData = {
                                                        serverAuthCode: req.query.code
                                                    };
                                                } else if (req.query.provider === "instagram") {
                                                    socialUserId = body.data.id;
                                                    if (body.data.full_name) socialUserName = body.data.full_name;
                                                    if (body.data.profile_picture) socialUserProfilePictureUrl = body.data.profile_picture;
                                                }

                                                socialLoginHandle(socialUserAccessToken, socialUserId, socialUserEmail, socialUserName, socialUserProfilePictureUrl, socialUserExtraData);
                                            } else {
                                                console.log("Unexpected Profile response:", {
                                                    query: req.query,
                                                    getData: getData,
                                                    error: error,
                                                    response: response,
                                                    body: body
                                                });
                                                res.status(200).send({ error: true });
                                            }
                                        } else {
                                            res.status(200).send({ error: true });
                                        }
                                    });
                                } else {
                                    console.log("Unexpected Token Response:", {
                                        query: req.query,
                                        postData: postData,
                                        error: error,
                                        response: response,
                                        body: body
                                    });
                                    if (body && ((body.error && body.error.message) || body.error_description || body.error_message)) {
                                        res.status(200).send({ message: (body.error_description || body.error_message || body.error.message) });
                                    } else {
                                        res.status(200).send({ error: true });
                                    }
                                }
                            } else {
                                res.status(200).send({ error: true });
                            }
                        });
                    }
                } else {
                    console.log("Unable to find firebase user to link in request:", req.query);
                    res.status(200).send({ error: true });
                }
            });
        } else {
            console.log("Error in request:", req.query);
            res.status(200).send({ error: true });
        }
    });
});
// [END handleSocialLoginTrigger]
// [END handleSocialLogin]

// [START sendNotificationsOnDiaryActivity]
/**
 * Handle sending notifications on diary activity.
 */
// [START sendNotificationsOnDiaryActivityTrigger]
exports.sendNotificationsOnDiaryActivity = functions.database.ref("/activities/diaries/{diaryId}/{activityId}").onWrite(event => {
    if (event.data.exists() && !event.data.previous.exists()) {
        let diaryId = event.params.diaryId;
        let activityId = event.params.activityId;
        let activity = event.data.val();

        return admin.database().ref(`/diaries/${diaryId}`).once("value").then(snapshot => {
            let diary = snapshot.val();

            if (diary && diary.ownerName && diary.ownerPersonId) {
                let diaryName = diary.ownerName;
                let diaryOwnerPersonId = diary.ownerPersonId;

                return admin.database().ref(`/persons/${diaryOwnerPersonId}/members`).once("value").then(snapshot => {
                    let diaryOwnerPersonMemberPersonIds = [diaryOwnerPersonId];

                    snapshot.forEach(member => {
                        diaryOwnerPersonMemberPersonIds.push(member.key);
                    });

                    if (diaryOwnerPersonMemberPersonIds.length > 0) {
                        let tokens = [];
                        let notificationTokenPromises = [];
                        let diaryOwnerPersonMemberUserIds = {};

                        for (let index in diaryOwnerPersonMemberPersonIds) {
                            let diaryOwnerPersonMemberPersonId = diaryOwnerPersonMemberPersonIds[index];

                            notificationTokenPromises.push(admin.database().ref(`/persons/${diaryOwnerPersonMemberPersonId}/userId`).once("value").then(snapshot => {
                                let diaryOwnerPersonMemberUserId = snapshot.val();

                                if (diaryOwnerPersonMemberUserId) {
                                    if (!diaryOwnerPersonMemberUserIds[diaryOwnerPersonMemberUserId] && diaryOwnerPersonMemberUserId !== activity.userId) {
                                        diaryOwnerPersonMemberUserIds[diaryOwnerPersonMemberUserId] = true;

                                        return admin.database().ref("/notificationTokens").orderByChild("userId").equalTo(diaryOwnerPersonMemberUserId).once("value").then(snapshot => {
                                            snapshot.forEach(notificationToken => {
                                                tokens.push(notificationToken.key);
                                            });
                                        }).catch(reason => {
                                            //TODODEV
                                            console.log(`NotificationTokens query failed for dirayId '${diaryId}' of activityId '${activityId}' for DiaryOwnerPerson's member with UserId '${diaryOwnerPersonMemberUserId}'.`, reason);
                                        });
                                    } else {
                                        return Promise.resolve();
                                    }
                                } else {
                                    //TODODEV
                                    console.log(`Person's UserId not found for dirayId '${diaryId}' of activityId '${activityId}' for DiaryOwnerPerson's member with PersonId '${diaryOwnerPersonMemberPersonId}'.`);
                                }
                            }).catch(reason => {
                                //TODODEV
                                console.log(`Person's UserId query failed for dirayId '${diaryId}' of activityId '${activityId}' for DiaryOwnerPerson's member with PersonId '${diaryOwnerPersonMemberPersonId}'.`, reason);
                            }));
                        }

                        return Promise.all(notificationTokenPromises).then(() => {
                            if (tokens.length > 0) {
                                let notificationMessages = {};
                                let formatString = (stringToFormat, values) => {
                                    if (stringToFormat && values && values.length && values.length > 0) {
                                        for (let index = 0; index < values.length; index++) {
                                            stringToFormat = stringToFormat.replace(new RegExp("\\{" + index + "\\}", "gm"), (values[index] || ""));
                                        }
                                    }

                                    return stringToFormat;
                                };

                                for (let language in i18n) {
                                    let notificationMessageTemplate = i18n[language].labelResources.activities[activity.activityType];

                                    if (notificationMessageTemplate) {
                                        let notificationMessage;

                                        switch (activity.activityType) {
                                            case activityTypes.diaryAdded:
                                            case activityTypes.diaryDeleted:
                                            case activityTypes.diaryLiked:
                                            case activityTypes.diaryCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.entryAdded:
                                            case activityTypes.entryDeleted:
                                            case activityTypes.entryLiked:
                                            case activityTypes.entryCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.storyAdded:
                                            case activityTypes.storyDeleted:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.story ? activity.context.contents.story : "")
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.storyLiked:
                                            case activityTypes.storyCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.story ? activity.context.contents.story : "")
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.imageAdded:
                                            case activityTypes.imageDeleted:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.imageLiked:
                                            case activityTypes.imageCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.collectionAdded:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contentCount ? activity.context.contentCount : 0)
                                                    , (activity.context && activity.context.title ? activity.context.title : "")
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.collectionDeleted:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contentCount ? activity.context.contentCount : 0)
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.collectionLiked:
                                            case activityTypes.collectionCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.videoAdded:
                                            case activityTypes.videoDeleted:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.context && activity.context.contents && activity.context.contents.entry ? activity.context.contents.entry : "")
                                                    , diaryName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                            case activityTypes.videoLiked:
                                            case activityTypes.videoCommented:
                                                notificationMessage = formatString(notificationMessageTemplate, [
                                                    activity.userName || ""
                                                    , (activity.createdOn ? DateTransformation.transformDate(activity.createdOn) : "")
                                                ]);

                                                break;
                                        }

                                        if (notificationMessage) {
                                            notificationMessages[language] = notificationMessage;
                                        } else {
                                            //TODODEV
                                            console.log(`Notification message could not be prepared for '${language}' language & '${activity.activityType}' activityType of activity with Id '${activityId}'.`);
                                        }
                                    } else {
                                        //TODODEV
                                        console.log(`Notification message template not found for '${language}' language & '${activity.activityType}' activityType of activity with Id '${activityId}'.`);
                                    }
                                }

                                let userLanguage = "en";
                                if (notificationMessages[userLanguage]) {
                                    //You can send messages to up to 1,000 devices in a single request. If you provide an array with over 1,000 registration tokens, the request will fail with a messaging/invalid-recipient error.
                                    let tokenChunks = [];
                                    while (tokens.length > 500) {
                                        tokenChunks.push(tokens.splice(0, 500));
                                    }
                                    if (tokens.length > 0) {
                                        tokenChunks.push(tokens);
                                    }

                                    let payload = {
                                        notification: {
                                            title: i18n[userLanguage].appName //iOS, Android, Web: The notification's title.
                                            , body: notificationMessages[userLanguage] //iOS, Android, Web: The notification's body text.
                                            // , badge?: string, //???
                                            // , clickAction: string, //???
                                            // , color: string, //???
                                            // , icon: string, //???
                                            // , sound: string, //???
                                            // , tag: string //???
                                        }
                                    };
                                    // payload.data = { key1: "value1", key2: "value2" }; //The keys and values must both be strings. Keys can be any custom string, except for the following reserved strings: "from" & Anything starting with "google."

                                    let sendNotificationPromises = [];
                                    for (let index in tokenChunks) {
                                        let tokenChunk = tokenChunks[index];

                                        sendNotificationPromises.push(admin.messaging().sendToDevice(tokenChunk, payload, {
                                            contentAvailable: true //On iOS, use this field to represent content-available in the APNs payload. When a notification or data message is sent and this is set to true, an inactive client app is awoken. On Android, data messages wake the app by default. On Chrome, this flag is currently not supported.
                                            , dryRun: false //Whether or not the message should actually be sent. When set to true, allows developers to test a request without actually sending a message. When set to false, the message will be sent.
                                            , mutableContent: false //On iOS, use this field to represent mutable-content in the APNs payload. When a notification is sent and this is set to true, the content of the notification can be modified before it is displayed, using a Notification Service app extension. On Android and Web, this parameter will be ignored.
                                            , priority: "high" //The priority of the message. Valid values are "normal" and "high". On iOS, these correspond to APNs priorities 5 and 10. By default, notification messages are sent with high priority, and data messages are sent with normal priority. Normal priority optimizes the client app's battery consumption and should be used unless immediate delivery is required. For messages with normal priority, the app may receive the message with unspecified delay. When a message is sent with high priority, it is sent immediately, and the app can wake a sleeping device and open a network connection to your server.
                                            , timeToLive: 2419200 //How long (in seconds) the message should be kept in FCM storage if the device is offline. The maximum time to live supported is four weeks, and the default value is also four weeks.  Keep in mind that a time_to_live value of 0 means messages that can't be delivered immediately are discarded.
                                            // , collapseKey: string //String identifying a group of messages (for example, "Updates Available") that can be collapsed, so that only the last message gets sent when delivery can be resumed. This is used to avoid sending too many of the same messages when the device comes back online or becomes active. There is no guarantee of the order in which messages get sent. A maximum of four different collapse keys is allowed at any given time. This means an FCM connection server can simultaneously store four different send-to-sync messages per client app. If you exceed this number, there is no guarantee which four collapse keys the FCM connection server will keep.
                                        }).then(response => {
                                            //TODODEV
                                            console.log(`Notification Sent Response for language '${userLanguage}' for dirayId '${diaryId}' of activity with Id '${activityId}'.:`, response);
                                        }).catch(reason => {
                                            //TODODEV
                                            console.log(`Notification Sent Reason for language '${userLanguage}' for dirayId '${diaryId}' of activity with Id '${activityId}'.:`, reason);
                                        }));
                                    }

                                    return Promise.all(sendNotificationPromises);
                                } else {
                                    //TODODEV
                                    console.log(`Notification message not available for language '${userLanguage}' for dirayId '${diaryId}' of activity with Id '${activityId}'.`);
                                }
                            } else {
                                //TODODEV
                                console.log(`Notification tockens not available for dirayId '${diaryId}' of activity with Id '${activityId}'.`);
                            }
                        });
                    } else {
                        //TODODEV
                        console.log(`DiaryOwnerPerson's members not available for dirayId '${diaryId}' of activity with Id '${activityId}'.`);
                    }
                }).catch(reason => {
                    //TODODEV
                    console.log(`DiaryOwnerPerson's members not available for dirayId '${diaryId}' of activity with Id '${activityId}'. Reason:`, reason);
                });
            } else {
                //TODODEV
                console.log(`Diary or DiaryName or DiaryOwnerPersonId not available for dirayId '${diaryId}' of activity with Id '${activityId}'. Diary:`, diary);
            }
        }).catch(reason => {
            //TODODEV
            console.log(`Diary name not available for dirayId '${diaryId}' of activity with Id '${activityId}'. Reason:`, reason);
        });
    }
});
// [END sendNotificationsOnDiaryActivityTrigger]
class DateTransformation {
    static transform(value, args) {
        value = value + '';
        args = args + '';

        return moment(value).format(args)
    }

    static transformDate(value) {
        if (DateTransformation.isToday(value)) {
            return DateTransformation.transform(value, "LT");
        } else if (DateTransformation.isYesterday(value)) {
            return DateTransformation.transform(value, "[Yesterday at] LT");
        }

        return DateTransformation.transform(value, "lll");
    }

    static isToday(value) {
        return moment(value).isSame(moment().clone().startOf('day'), 'd');
    }

    static isYesterday(value) {
        return moment(value).isSame(moment().subtract(1, 'days').startOf('day'), 'd');
    }

    static isWithinAWeek(value) {
        return moment(value).isAfter(moment().subtract(7, 'days').startOf('day'));
    }

    static isTwoWeeksOrMore(value) {
        return !DateTransformation.isWithinAWeek(moment(value));
    }
}
// [END sendNotificationsOnDiaryActivity]

// [START sendTestNotification]
/**
 * Handle sending test notifications to a user.
 */
// [START sendTestNotificationTrigger]
exports.sendTestNotification = functions.https.onRequest((req, res) => {
    cors(req, res, () => {
        if (req && req.query && req.query.userId && req.query.title && req.query.body) {
            admin.database().ref("/notificationTokens").orderByChild("userId").equalTo(req.query.userId).once("value").then(snapshot => {
                let notificationTokens = snapshot.val();
                if (notificationTokens) {
                    let tokens = [];
                    for (let notificationToken in notificationTokens) {
                        tokens.push(notificationToken);
                    }
                    if (tokens.length > 0) {
                        //You can send messages to up to 1,000 devices in a single request. If you provide an array with over 1,000 registration tokens, the request will fail with a messaging/invalid-recipient error.
                        let tokenChunks = [];
                        while (tokens.length > 500) {
                            tokenChunks.push(tokens.splice(0, 500));
                        }
                        if (tokens.length > 0) {
                            tokenChunks.push(tokens);
                        }

                        let payload = {
                            notification: {
                                title: req.query.title //iOS, Android, Web: The notification's title.
                                , body: req.query.body //iOS, Android, Web: The notification's body text.
                                // , badge?: string, //???
                                // , clickAction: string, //???
                                // , color: string, //???
                                // , icon: string, //???
                                // , sound: string, //???
                                // , tag: string //???
                            }
                        };
                        if (req.query.data && Object.keys(req.query.data).length > 0) {
                            payload.data = req.query.data; //The keys and values must both be strings. Keys can be any custom string, except for the following reserved strings: "from" & Anything starting with "google."
                        }

                        for (let index in tokenChunks) {
                            let tokenChunk = tokenChunks[index];

                            admin.messaging().sendToDevice(tokenChunk, payload, {
                                contentAvailable: true //On iOS, use this field to represent content-available in the APNs payload. When a notification or data message is sent and this is set to true, an inactive client app is awoken. On Android, data messages wake the app by default. On Chrome, this flag is currently not supported.
                                , dryRun: false //Whether or not the message should actually be sent. When set to true, allows developers to test a request without actually sending a message. When set to false, the message will be sent.
                                , mutableContent: false //On iOS, use this field to represent mutable-content in the APNs payload. When a notification is sent and this is set to true, the content of the notification can be modified before it is displayed, using a Notification Service app extension. On Android and Web, this parameter will be ignored.
                                , priority: "high" //The priority of the message. Valid values are "normal" and "high". On iOS, these correspond to APNs priorities 5 and 10. By default, notification messages are sent with high priority, and data messages are sent with normal priority. Normal priority optimizes the client app's battery consumption and should be used unless immediate delivery is required. For messages with normal priority, the app may receive the message with unspecified delay. When a message is sent with high priority, it is sent immediately, and the app can wake a sleeping device and open a network connection to your server.
                                , timeToLive: 2419200 //How long (in seconds) the message should be kept in FCM storage if the device is offline. The maximum time to live supported is four weeks, and the default value is also four weeks.  Keep in mind that a time_to_live value of 0 means messages that can't be delivered immediately are discarded.
                                // , collapseKey: string //String identifying a group of messages (for example, "Updates Available") that can be collapsed, so that only the last message gets sent when delivery can be resumed. This is used to avoid sending too many of the same messages when the device comes back online or becomes active. There is no guarantee of the order in which messages get sent. A maximum of four different collapse keys is allowed at any given time. This means an FCM connection server can simultaneously store four different send-to-sync messages per client app. If you exceed this number, there is no guarantee which four collapse keys the FCM connection server will keep.
                            }).then(response => {
                                console.log("Notification Sent:", response);
                                res.status(200).send();
                            }).catch(reason => {
                                console.log("Notification Sent Reason:", reason);
                                res.status(200).send();
                            });
                        }
                    } else {
                        res.status(200).send();
                    }
                }
            }).catch(reason => {
                console.log("NotificationTokens query Reason: ", reason);
                res.status(200).send();
            });
        } else {
            res.status(200).send();
        }
    });
});
// [END sendTestNotificationTrigger]
// [END sendTestNotification]