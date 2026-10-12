-- edge-fill.lua – used by the Video Screensaver extension
--
-- Pads every video to the screen aspect ratio and fills the added bars by
-- repeating the video's border pixels, so a video with a plain background
-- (e.g. white) looks continuous on wider/taller screens.
--
-- Option: --script-opts=edge_fill-aspect=<screen width / screen height>

local options = require 'mp.options'

local opts = {aspect = 0}
options.read_options(opts, 'edge_fill')

local applied = nil

-- Round to the nearest even number (required by 4:2:0 chroma subsampling)
local function even(n)
    return math.floor(n / 2 + 0.5) * 2
end

mp.observe_property('video-params', 'native', function(_, p)
    if not p or not p.w or not p.h or not p.dw or not p.dh or opts.aspect <= 0 then
        return
    end

    local w, h = p.w, p.h
    -- Target ratio in storage pixels (accounts for non-square pixels)
    local sar = (p.dw * h) / (p.dh * w)
    local ratio = opts.aspect / sar

    local W, H = w, h
    if w / h < ratio then
        W = even(h * ratio)
    else
        H = even(w / ratio)
    end

    local vf = ''
    if W - w >= 2 or H - h >= 2 then
        local left = math.floor((W - w) / 4) * 2
        local top = math.floor((H - h) / 4) * 2
        vf = string.format(
            'lavfi=[pad=%d:%d:%d:%d,fillborders=left=%d:right=%d:top=%d:bottom=%d:mode=smear]',
            W, H, left, top, left, W - w - left, top, H - h - top)
    end

    if vf ~= applied then
        applied = vf
        mp.set_property('vf', vf)
    end
end)
