// This file is part of MusicBrainz, the open internet music database.
// Copyright (C) 2014 MetaBrainz Foundation
// Licensed under the GPL version 2, or (at your option) any later version:
// http://www.gnu.org/licenses/gpl-2.0.txt

(function (releaseEditor) {

    var recordingAssociation = releaseEditor.recordingAssociation = {};
    var utils = releaseEditor.utils;

    var MAX_LENGTH_DIFFERENCE = 10500;

    // This file contains code for finding suggested recording associations
    // in the release editor.
    //
    // Levenshtein is used to compare track & recording titles, and track
    // lengths are checked to be within 10s of recording lengths.
    //
    // Recordings from the same release group are preferred. Since there are
    // usually less than 50 recordings in a release group, we request and cache
    // all of them as soon as the release group changes. If there is no release
    // group (i.e. one isn't selected), all recordings of the selected track's
    // artists are searched using the web service.
    //
    // Direct database search is terrible at matching titles (a single
    // apostrophe changes the entire set of results), so indexed search is
    // used. To get around the 3-hour delay of indexes updating, we also GET
    // the endpoint /ws/js/last-updated-recordings, which accepts an array of
    // artist IDs and returns all unique recordings for those artists that were
    // created/updated within the last 3 hours. (It just uses the last_updated
    // column to find these.)

    var releaseField = ko.observable().subscribeTo("releaseField", true),
        releaseGroupRecordings = ko.observable(),
        releaseGroupTimer,
        recentRecordings = [],
        trackArtistIDs = [];


    var releaseGroupField = MB.utility.computedWith(
        function (release) { return release.releaseGroup() }, releaseField
    );


    releaseGroupField.subscribe(function (releaseGroup) {
        if (releaseGroupTimer) clearTimeout(releaseGroupTimer);

        var getRecordings = function () {
            getReleaseGroupRecordings(releaseGroup, 0, []);
        };

        // Refresh our list of recordings every 10 minutes, in case the user
        // leaves the tab open and comes back later, potentially leaving us
        // with stale data.
        releaseGroupTimer = setTimeout(getRecordings, 10 * 60 * 1000);

        getRecordings();
    });


    utils.debounce(utils.withRelease(function (release) {
        var newIDs = _(release.mediums()).invoke("tracks").flatten()
                      .pluck("artistCredit").invoke("names").flatten()
                      .invoke("artist").pluck("id").uniq().compact().value();

        // Check if the current set of ids is identical, to avoid triggering
        // a superfluous request below.
        var numInCommon = _.intersection(trackArtistIDs, newIDs).length;

        if (numInCommon !== trackArtistIDs.length ||
            numInCommon !== newIDs.length) {

            var requestArgs = {
                url: "/ws/js/last-updated-recordings",
                data: $.param({ artists: newIDs }, true /* traditional */)
            };

            MB.utility.request(requestArgs).done(function (data) {
                recentRecordings = data.recordings;
            });

            trackArtistIDs = newIDs;
        }
    }));


    function getReleaseGroupRecordings(releaseGroup, offset, results) {
        if (!releaseGroup || !releaseGroup.gid) return;

        var queryParams = {
            rgid: [ utils.escapeLuceneValue(releaseGroup.gid) ]
        };

        utils.search("recording", queryParams, 100, offset)
            .done(function (data) {
                results.push.apply(
                    results, _.map(data.recording, utils.cleanWebServiceData)
                );

                var countSoFar = data.offset + 100;

                if (countSoFar < data.count) {
                    getReleaseGroupRecordings(releaseGroup, countSoFar, results);
                } else {
                    releaseGroupRecordings(results);
                }
            })
            .fail(function () {
                _.delay(getReleaseGroupRecordings, 5000, releaseGroup, offset, results);
            });
    }


    function recordingQueryParams(track, name) {
        var params = {
            recording: [ utils.escapeLuceneValue(name) ],

            arid: _(track.artistCredit.names()).invoke("artist")
                .pluck("gid").map(utils.escapeLuceneValue).value()
        };

        var duration = parseInt(track.length(), 10);

        if (duration) {
            params.dur = [
                _.str.sprintf("[%d TO %d]",
                    duration - MAX_LENGTH_DIFFERENCE,
                    duration + MAX_LENGTH_DIFFERENCE)
            ];
        }

        return params;
    }


    function cleanRecordingData(data) {
        var clean = utils.cleanWebServiceData(data);

        clean.artist = MB.entity.ArtistCredit(clean.artistCredit).text();
        clean.video = !!data.video;

        var appearsOn = _(data.releases)
            .map(function (release) {
                // The webservice doesn't include the release group title, so
                // we have to use the release title instead.
                return {
                    name: release.title,
                    gid: release.id,
                    releaseGroupGID: release["release-group"].id
                };
            })
            .uniq(false, "releaseGroupGID").value();

        clean.appearsOn = {
            hits: appearsOn.length,
            results: appearsOn,
            entityType: "release"
        };

        return clean;
    }


    function searchTrackArtistRecordings(track) {
        if (track._recordingRequest) {
            track._recordingRequest.abort();
            delete track._recordingRequest;
        }

        track.loadingSuggestedRecordings(true);

        var params = recordingQueryParams(track, track.name());

        track._recordingRequest = utils.search("recording", params)
            .done(function (data) {
                var recordings = matchAgainstRecordings(
                    track, _.map(data.recording, cleanRecordingData)
                );

                track.suggestedRecordings(recordings || []);
                track.loadingSuggestedRecordings(false);
            })
            .fail(function (jqXHR, textStatus) {
                if (textStatus !== "abort") {
                    _.delay(searchTrackArtistRecordings, 5000, track);
                }
            });
    }


    // Allow the recording search autocomplete to also get better results.
    // The standard /ws/js indexed search doesn't support sending artist or
    // length info.

    recordingAssociation.autocompleteHook = function (track) {
        return function (args) {
            if (args.data.direct) return args;

            var newArgs = {
                url: "/ws/2/recording",
                data: {
                    query: utils.constructLuceneFieldConjunction(
                        recordingQueryParams(track, args.data.q)
                    ),
                    fmt: "json"
                },
                dataType: "json"
            };

            newArgs.success = function (data) {
                // Emulate the /ws/js response format.
                var newData = _.map(data.recording, cleanRecordingData);

                newData.push({
                    current: (data.offset / 10) + 1,
                    pages: Math.ceil(data.count / 10)
                });

                args.success(newData);
            };

            newArgs.error = args.error;
            newArgs.data.limit = 10;
            newArgs.data.offset = (args.data.page - 1) * 10;

            return newArgs;
        };
    };


    function similarNames(oldName, newName) {
        return oldName == newName || MB.utility.nameIsSimilar(oldName, newName);
    }

    function similarLengths(oldLength, newLength) {
        // If either of the lengths are empty, we can't compare them, so we
        // consider them to be "similar" for recording association purposes.
        return !oldLength || !newLength || lengthsAreWithin10s(oldLength, newLength);
    }


    function watchTrackForChanges(track) {
        var name = track.name();
        var length = track.length();

        // We don't compare any artist credit changes, but we use the track
        // artists when searching the web service. If there are track changes
        // below but the AC is not complete, the ko.computed this is inside of
        // will re-evaluate once the user fixes the artist.
        var completeAC = track.artistCredit.isComplete();

        // Only proceed if we need a recording, and the track has information
        // we can search for - this tab should be disabled otherwise, anyway.
        if (!name || !completeAC) return;

        var similarTo = function (prop) {
            return (similarNames(track.name[prop], name) &&
                    similarLengths(track.length[prop], length));
        };

        // The current name/length is similar to the saved name/length.
        if (similarTo("saved")) {
            track.recording(track.recording.saved);
        }
        // The current name/length is similar to the original name/length.
        else if (similarTo("original")) {
            track.recording(track.recording.original.peek());
        }
        else {
            track.recording(null);
        }
    }


    recordingAssociation.findRecordingSuggestions = function (track) {
        var releaseGroup = releaseGroupField(),
            rgRecordings;

        if (releaseGroup && releaseGroup.gid) {
            // First look in releaseGroupRecordings.
            rgRecordings = releaseGroupRecordings();

            if (!rgRecordings) {
                // If they aren't loaded yet for some reason, wait until they are.

                if (!releaseGroupRecordings.loading) {
                    releaseGroupRecordings.loading = releaseGroupRecordings.subscribe(
                        function () {
                            releaseGroupRecordings.loading.dispose();
                            delete releaseGroupRecordings.loading;

                            recordingAssociation.findRecordingSuggestions(track);
                        });
                }
                return;
            }
        }

        var recordings =
                matchAgainstRecordings(track, rgRecordings) ||
                // Next try to match against one of the recent recordings.
                matchAgainstRecordings(track, recentRecordings) ||
                // Or see if it still matches the current suggestion.
                matchAgainstRecordings(track, track.suggestedRecordings());

        if (recordings) {
            track.suggestedRecordings(recordings);
        } else {
            // Last resort: search all recordings of all the track's artists.
            searchTrackArtistRecordings(track);
        }
    };


    function lengthsAreWithin10s(a, b) {
        return Math.abs(a - b) <= MAX_LENGTH_DIFFERENCE;
    }


    function matchAgainstRecordings(track, recordings) {
        if (!recordings || !recordings.length) return;

        var trackLength = track.length();
        var trackName = track.name();

        var matches = _(recordings)
            .map(function (recording) {
                if (similarLengths(trackLength, recording.length) &&
                        similarNames(trackName, recording.name)) {
                    return recording;
                }
            })
            .compact()
            .sortBy(function (recording) {
                if (!trackLength || !recording.length) {
                    return MAX_LENGTH_DIFFERENCE;
                }
                return Math.abs(trackLength - recording.length);
            })
            .value();

        if (matches.length) {
            return _.map(matches, function (match) {
                return MB.entity(match, "recording");
            });
        }
    }


    recordingAssociation.track = function (track) {
        utils.debounce(ko.computed(function () { watchTrackForChanges(track) }));
    };

}(MB.releaseEditor = MB.releaseEditor || {}));
