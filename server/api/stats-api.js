var GameRecord = require("../database/game-record-model");
var _ = require("underscore");

module.exports = function(app) {

    app.get("/api/stats/levels", function (req, res) {

        res.format({
            json: function () {
                GameRecord.find({}).lean().exec(function (err, games) {

                    var monsterDeathGames = _.filter(games, function (game) {
                        return game.description && game.description.search("Killed") != -1;
                    });

                    var monsterDeathGamesWithCause = _.map(monsterDeathGames, function (game) {

                        var monsterRe = new RegExp("by\\s+[an]*\\s+(.*?)\\s+on");
                        var descriptionMatch = monsterRe.exec(game.description);
                        if (descriptionMatch) {
                            game["cause"] = descriptionMatch[1];
                        }
                        else {
                            game["cause"] = "unknown";
                        }

                        return game;
                    });

                    var burnedDeathGames = _.filter(games, function (game) {
                        return game.description && game.description.search("Burned") != -1;
                    });

                    var burnedDeathGamesWithCause = _.map(burnedDeathGames, function(game) {
                        game["cause"] = "burned to death";
                        return game;
                    });

                    var poisonedDeathGames = _.filter(games, function (game) {
                        return game.description && game.description.search("poison") != -1;
                    });

                    var poisonedDeathGamesWithCause = _.map(poisonedDeathGames, function(game) {
                        game["cause"] = "poison";
                        return game;
                    });

                    var starvedDeathGames = _.filter(games, function (game) {
                        return game.description && game.description.search("Starved") != -1;
                    });

                    var starvedDeathGamesWithCause = _.map(starvedDeathGames, function(game) {
                        game["cause"] = "starved";
                        return game;
                    });

                    var lavaDeathGames = _.filter(games, function (game) {
                        return game.description && game.description.search("by lava") != -1;
                    });

                    var lavaDeathGamesWithCause = _.map(lavaDeathGames, function(game) {
                        game["cause"] = "lava";
                        return game;
                    });

                    var allDeathGamesWithCause = monsterDeathGamesWithCause
                        .concat(burnedDeathGamesWithCause)
                        .concat(poisonedDeathGamesWithCause)
                        .concat(starvedDeathGamesWithCause)
                        .concat(lavaDeathGamesWithCause);

                    var deathGamesByLevel = _.groupBy(allDeathGamesWithCause, "level");

                    var deathNumbersByLevel = _.mapObject(deathGamesByLevel, function(levelGames, level) {

                        var deathsByCauseOnLevel = _.groupBy(levelGames, "cause");
                        var numberOfDeathsByCauseOnLevel = _.mapObject(deathsByCauseOnLevel, function(causeGames, thisCause) {
                            return causeGames.length;
                        });

                        var numberOfDeathsByCauseOnLevelAsArray = _.map(numberOfDeathsByCauseOnLevel, function(value, key){
                            return { cause : key, frequency : value };
                        });
                        var numberOfDeathsByCauseOnLevelAsArraySorted = _.sortBy(numberOfDeathsByCauseOnLevelAsArray, "frequency").reverse();

                        return numberOfDeathsByCauseOnLevelAsArraySorted;
                    });

                    res.json(deathNumbersByLevel);
                });
            }
        });
    });
};