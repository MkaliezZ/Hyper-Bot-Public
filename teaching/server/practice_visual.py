"""Prepare bounded raster figures for portable practice worksheets."""

from base64 import b64encode
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import re
import warnings

from PIL import Image, ImageOps

from practice_material import PracticeProblem


MAX_INPUT_BYTES = 12 * 1024 * 1024
MAX_INPUT_PIXELS = 24_000_000
MAX_EMBEDDED_BYTES = 2 * 1024 * 1024
MAX_VISUAL_BYTES = 6 * 1024 * 1024
MAX_EDGE = 1600
RASTER_SOURCE = re.compile(r'data:image/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}', re.ASCII)


@dataclass(frozen=True)
class Visual:
    data_url: str
    alt: str
    caption: str
    width: int
    height: int


def encode_raster(image, file_format):
    with BytesIO() as buffer:
        if file_format == 'PNG':
            image.save(buffer, format=file_format, optimize=True)
        else:
            image.save(buffer, format=file_format, quality=88, optimize=True)
        return buffer.getvalue()


def load_visual(path: Path, alt: str, caption: str = '') -> Visual:
    """Decode an actual raster, then write a clean, print-friendly copy without metadata."""
    try:
        if not 0 < path.stat().st_size <= MAX_INPUT_BYTES:
            raise PracticeProblem('PRACTICE_IMAGE')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(path, formats=('PNG', 'JPEG', 'WEBP')) as source:
                if not 0 < source.width * source.height <= MAX_INPUT_PIXELS:
                    raise PracticeProblem('PRACTICE_IMAGE')
                file_format = 'PNG' if source.format == 'PNG' else 'JPEG'
                source.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
                image = ImageOps.exif_transpose(source).convert('RGBA')
        clean = Image.new('RGB', image.size, 'white')
        clean.paste(image, mask=image.getchannel('A'))
        content = encode_raster(clean, file_format)
        if len(content) > MAX_EMBEDDED_BYTES and file_format == 'PNG':
            file_format = 'JPEG'
            content = encode_raster(clean, file_format)
        if len(content) > MAX_EMBEDDED_BYTES:
            raise PracticeProblem('PRACTICE_IMAGE')
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise PracticeProblem('PRACTICE_IMAGE') from error

    return Visual(
        f'data:image/{file_format.lower()};base64,{b64encode(content).decode("ascii")}',
        alt.strip() or '练习配图',
        caption.strip(),
        clean.width,
        clean.height,
    )
