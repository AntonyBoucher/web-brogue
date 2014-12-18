var mongoose = require('mongoose');
var bcrypt = require('bcrypt-nodejs');

var userSchema = mongoose.Schema({
    username: String,
    password: String
});

userSchema.methods.isValidPassword = function (password) {
    return bCrypt.compareSync(password, this.local.password);
};

userSchema.methods.createHash = function (password) {
    return bCrypt.hashSync(password, bCrypt.genSaltSync(10), null);
};

module.exports = mongoose.model('User', userSchema);