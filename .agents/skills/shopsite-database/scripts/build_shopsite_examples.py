#!/usr/bin/env python3
"""Generate documentation-grounded ShopSite example artifacts.

This helper is intentionally conservative:
- it validates only the documented surfaces summarized in this skill
- it generates examples only; it never sends requests
- it labels version-variable and unspecified details as notes instead of facts
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from textwrap import dedent
from urllib.parse import urlencode

SUPPORTED_DATABASES = {"products", "pages"}
DOWNLOAD_VERSIONS = {"8.3", "8.2", "8.1", "8.0", "7.1"}
YES_NO = {"yes", "no"}
PRODUCT_KEYS = {"Name", "SKU", "(none)"}
PAGE_KEYS = {"Name", "File+Name", "(none)"}


@dataclass
class Rendered:
    title: str
    body: str
    notes: list[str]

    def to_text(self) -> str:
        note_block = "\n".join(f"- {note}" for note in self.notes)
        return f"# {self.title}\n\n{self.body}\n\nNotes:\n{note_block}\n"


def normalize_unique_name(value: str) -> str:
    lowered = value.strip().lower()
    if lowered in {"none", "(none)"}:
        return "(none)"
    return value


def validate_dbname(dbname: str) -> None:
    if dbname not in SUPPORTED_DATABASES:
        raise SystemExit("dbname must be 'products' or 'pages'.")


def validate_unique_name(dbname: str, unique_name: str) -> None:
    valid = PRODUCT_KEYS if dbname == "products" else PAGE_KEYS
    if unique_name not in valid:
        allowed = ", ".join(sorted(valid))
        raise SystemExit(f"invalid uniqueName for {dbname}: {unique_name}. Allowed: {allowed}")


def validate_yes_no(field: str, value: str | None) -> None:
    if value is None:
        return
    if value not in YES_NO:
        raise SystemExit(f"{field} must be 'yes' or 'no'.")


def join_url(base_url: str, endpoint: str) -> str:
    return f"{base_url.rstrip('/')}/{endpoint}"


def render_download(args: argparse.Namespace) -> Rendered:
    validate_dbname(args.dbname)
    if args.version and args.version not in DOWNLOAD_VERSIONS:
        allowed = ", ".join(sorted(DOWNLOAD_VERSIONS, reverse=True))
        raise SystemExit(f"version must be one of: {allowed}")

    params: dict[str, str | int] = {
        "clientApp": 1,
        "dbname": args.dbname,
    }
    if args.download_shopsite_version:
        params["download_shopsite_version"] = 1
    if args.version:
        params["version"] = args.version
    if args.fields:
        params["fields"] = "|" + "|".join(args.fields) + "|"
    if args.fieldmap:
        params["fieldmap"] = args.fieldmap

    query = urlencode(params)
    url = f"{join_url(args.base_url, 'db_xml.cgi')}?{query}"

    notes = [
        "ShopSite documents this CGI for products/pages XML downloads.",
        "The docs describe standard HTTP POST invocation but also show query-style examples like this.",
        "Authentication for automated CGI calls is environment-specific and not specified by the grounded docs.",
    ]
    if args.fields:
        notes.append("The fields list is rendered as a pipe-delimited value, then URL-encoded.")
    if args.version:
        notes.append(f"Using XML compatibility version {args.version}.")

    body = dedent(
        f"""
        Example URL:
        {url}
        """
    ).strip()
    return Rendered("ShopSite download example", body, notes)


def render_upload(args: argparse.Namespace) -> Rendered:
    validate_dbname(args.dbname)
    args.unique_name = normalize_unique_name(args.unique_name)
    validate_unique_name(args.dbname, args.unique_name)
    validate_yes_no("newRecords", args.new_records)
    validate_yes_no("defer_linking", args.defer_linking)
    validate_yes_no("use_optimizer", args.use_optimizer)

    params: dict[str, str | int] = {
        "clientApp": 1,
        "dbname": args.dbname,
        "uniqueName": args.unique_name,
        "newRecords": args.new_records,
        "defer_linking": args.defer_linking,
    }
    if args.restart:
        params["restart"] = 1
    if args.filename:
        params["filename"] = args.filename
    if args.checkpoint is not None:
        if args.checkpoint <= 0:
            raise SystemExit("checkpoint must be a positive integer.")
        params["checkpoint"] = args.checkpoint
    if args.use_optimizer:
        params["use_optimizer"] = args.use_optimizer

    query = urlencode(params)
    url = f"{join_url(args.base_url, 'dbupload.cgi')}?{query}"

    notes = [
        "Only products and pages are documented automated XML upload targets in the grounded docs.",
        "Authentication for automated CGI calls is environment-specific and not specified by the grounded docs.",
        "After import, publish/regenerate the store so shoppers can see the changes.",
    ]
    if args.unique_name == "(none)":
        notes.append("uniqueName=(none) disables matching and can create duplicates.")
    if args.new_records == "no":
        notes.append("newRecords=no means unmatched rows will be ignored.")
    if args.restart:
        notes.append("restart=1 is the documented automated recovery path for interrupted uploads.")
    if args.checkpoint is not None:
        notes.append("checkpoint is version-variable in the docs; confirm support in the target ShopSite environment.")
    if args.use_optimizer:
        notes.append("use_optimizer is inconsistently documented across official pages; treat it as version-variable.")
    if args.defer_linking == "yes":
        notes.append("If this is not the final batch, remember to complete linking and publish after the final upload.")

    body = dedent(
        f"""
        Example URL:
        {url}
        """
    ).strip()
    return Rendered("ShopSite upload example", body, notes)


def render_publish(args: argparse.Namespace) -> Rendered:
    params: dict[str, str | int] = {"clientApp": 1}
    enabled_flags: list[str] = []

    for flag in ("htmlpages", "custompages", "index", "regen", "sitemap"):
        if getattr(args, flag):
            params[flag] = 1
            enabled_flags.append(flag)

    if not enabled_flags:
        raise SystemExit("select at least one publish flag, e.g. --htmlpages --custompages --index")

    query = urlencode(params)
    url = f"{join_url(args.base_url, 'generate.cgi')}?{query}"

    notes = [
        "Use publish/regeneration after successful imports so storefront changes become visible.",
        "sitemap is version-variable in the grounded docs; include it only if the target environment supports it.",
        f"Enabled flags: {', '.join(enabled_flags)}.",
    ]

    body = dedent(
        f"""
        Example URL:
        {url}
        """
    ).strip()
    return Rendered("ShopSite publish example", body, notes)


def product_xml_fragment(filename: str) -> str:
    return dedent(
        f"""
        --ShopSiteUpload_boundary
        Content-Disposition: form-data; name="Desktop"; filename="{filename}"
        Content-Type: text/xml

        <?xml version="1.0" encoding="iso-8859-1"?>
        <!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/1.2/shopsiteproducts.dtd">
        <ShopSiteProducts>
          <Response>
            <ResponseCode>1</ResponseCode>
            <ResponseDescription>success</ResponseDescription>
          </Response>
          <Products>
            <Product>
              <Name>example-product</Name>
            </Product>
          </Products>
        </ShopSiteProducts>
        --ShopSiteUpload_boundary--
        """
    ).strip()


def page_placeholder_fragment(filename: str) -> str:
    return dedent(
        f"""
        --ShopSiteUpload_boundary
        Content-Disposition: form-data; name="Desktop"; filename="{filename}"
        Content-Type: text/xml

        <!-- Placeholder only: the crawlable ShopSite XML pages do not publish an official page XML example. -->
        <!-- Export a ShopSite-generated pages sample and use that as the authoritative body here. -->
        --ShopSiteUpload_boundary--
        """
    ).strip()


def render_mime(args: argparse.Namespace) -> Rendered:
    validate_dbname(args.dbname)
    args.unique_name = normalize_unique_name(args.unique_name)
    validate_unique_name(args.dbname, args.unique_name)
    validate_yes_no("newRecords", args.new_records)
    validate_yes_no("defer_linking", args.defer_linking)
    validate_yes_no("use_optimizer", args.use_optimizer)

    lines = [
        "--ShopSiteUpload_boundary",
        'Content-Disposition: form-data; name="clientApp"',
        "",
        "1",
        "--ShopSiteUpload_boundary",
        'Content-Disposition: form-data; name="dbname"',
        "",
        args.dbname,
        "--ShopSiteUpload_boundary",
        'Content-Disposition: form-data; name="uniqueName"',
        "",
        args.unique_name,
        "--ShopSiteUpload_boundary",
        'Content-Disposition: form-data; name="newRecords"',
        "",
        args.new_records,
        "--ShopSiteUpload_boundary",
        'Content-Disposition: form-data; name="defer_linking"',
        "",
        args.defer_linking,
    ]
    if args.batchsize is not None:
        if args.batchsize <= 0:
            raise SystemExit("batchsize must be a positive integer.")
        lines += [
            "--ShopSiteUpload_boundary",
            'Content-Disposition: form-data; name="batchsize"',
            "",
            str(args.batchsize),
        ]
    if args.use_optimizer:
        lines += [
            "--ShopSiteUpload_boundary",
            'Content-Disposition: form-data; name="use_optimizer"',
            "",
            args.use_optimizer,
        ]

    preamble = "\n".join(lines).strip()
    file_block = product_xml_fragment(args.filename) if args.dbname == "products" else page_placeholder_fragment(args.filename)
    body = f"Multipart starter:\n{preamble}\n{file_block}"

    notes = [
        "This is a documentation-derived starter, not a guaranteed complete execution artifact.",
        "After a MIME upload, pass the returned return_string to dbmake.cgi exactly as returned.",
        "Publish/regenerate after import so storefront changes become visible.",
    ]
    if args.dbname == "products":
        notes.append("The Response block appears in the crawlable product example, but its requiredness for uploads is unspecified.")
    else:
        notes.append("The crawlable docs do not show an official page XML example, so the body here is intentionally a placeholder.")
    if args.use_optimizer:
        notes.append("use_optimizer is inconsistently documented across official pages; treat it as version-variable.")
    if args.batchsize is not None:
        notes.append("batchsize appears in the MIME example but is not fully formalized in the later parameter tables.")

    return Rendered("ShopSite MIME starter", body, notes)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate ShopSite example artifacts without sending requests.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    download = subparsers.add_parser("download", help="Build a db_xml.cgi example.")
    download.add_argument("--base-url", required=True, help="Base CGI path, e.g. https://store.example.com/cgi-bin/merchant")
    download.add_argument("--dbname", required=True, choices=sorted(SUPPORTED_DATABASES))
    download.add_argument("--version")
    download.add_argument("--download-shopsite-version", action="store_true")
    download.add_argument("--fields", nargs="*")
    download.add_argument("--fieldmap")
    download.set_defaults(func=render_download)

    upload = subparsers.add_parser("upload", help="Build a dbupload.cgi example.")
    upload.add_argument("--base-url", required=True, help="Base CGI path, e.g. https://store.example.com/cgi-bin/merchant")
    upload.add_argument("--dbname", required=True, choices=sorted(SUPPORTED_DATABASES))
    upload.add_argument("--unique-name", default="Name")
    upload.add_argument("--new-records", default="yes")
    upload.add_argument("--defer-linking", default="no")
    upload.add_argument("--restart", action="store_true")
    upload.add_argument("--filename")
    upload.add_argument("--checkpoint", type=int)
    upload.add_argument("--use-optimizer")
    upload.set_defaults(func=render_upload)

    publish = subparsers.add_parser("publish", help="Build a generate.cgi example.")
    publish.add_argument("--base-url", required=True, help="Base CGI path, e.g. https://store.example.com/cgi-bin/merchant")
    publish.add_argument("--htmlpages", action="store_true")
    publish.add_argument("--custompages", action="store_true")
    publish.add_argument("--index", action="store_true")
    publish.add_argument("--regen", action="store_true")
    publish.add_argument("--sitemap", action="store_true")
    publish.set_defaults(func=render_publish)

    mime = subparsers.add_parser("mime", help="Build a documentation-derived MIME starter.")
    mime.add_argument("--dbname", required=True, choices=sorted(SUPPORTED_DATABASES))
    mime.add_argument("--unique-name", default="Name")
    mime.add_argument("--new-records", default="yes")
    mime.add_argument("--defer-linking", default="no")
    mime.add_argument("--filename", default="upload.xml")
    mime.add_argument("--batchsize", type=int)
    mime.add_argument("--use-optimizer")
    mime.set_defaults(func=render_mime)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    rendered = args.func(args)
    print(rendered.to_text())


if __name__ == "__main__":
    main()
